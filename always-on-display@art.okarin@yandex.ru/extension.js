// Always On Display for GNOME Shell 46+
// Shows clock/date/notifications on black background instead of blanking the display

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Overview from 'resource:///org/gnome/shell/ui/overview.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

// D-Bus interface for display power management
const DisplayConfigIface = `<node>
<interface name="org.gnome.Mutter.DisplayConfig">
    <property name="PowerSaveMode" type="i" access="readwrite"/>
</interface>
</node>`;
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);

// D-Bus interface for UPower (battery monitoring)
const UPowerIface = loadInterfaceXML('org.freedesktop.UPower');
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerIface);

// D-Bus interface for screen brightness
const BrightnessIface = `<node>
<interface name="org.gnome.SettingsDaemon.Power.Screen">
    <property name="Brightness" type="i" access="readwrite"/>
</interface>
</node>`;
const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(BrightnessIface);

// Singleton AOD controller, accessible from hook functions
let aod = null;

class AlwaysOnDisplay {
    constructor(settings) {
        this._settings = settings;
        this._inAOD = false;
        this._inLock = false;
        this._screenBlanked = false;
        this._savedBrightness = -1;
        this._aodTimeoutId = 0;
        this._idleWatchId = 0;
        this._userActiveWatchId = 0;

        // Save original ScreenShield methods
        this._origSetActive = Main.screenShield._setActive;
        this._origActivateFade = Main.screenShield._activateFade;
        this._origResetLockScreen = Main.screenShield._resetLockScreen;
        this._origOnUserBecameActive = Main.screenShield._onUserBecameActive;
        this._origRefreshBackground = Main.screenShield._refreshBackground;

        // D-Bus proxies
        this._displayProxy = new DisplayConfigProxy(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            () => {}
        );

        this._powerSignalId = 0;
        this._powerProxy = new UPowerProxy(
            Gio.DBus.system,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower',
            (proxy, error) => {
                if (error) {
                    logError(error, 'AlwaysOnDisplay: UPower proxy error');
                    return;
                }
                this._powerSignalId = this._powerProxy.connect(
                    'g-properties-changed',
                    this._onPowerChanged.bind(this));
            }
        );

        this._brightnessProxy = new BrightnessProxy(
            Gio.DBus.session,
            'org.gnome.SettingsDaemon.Power',
            '/org/gnome/SettingsDaemon/Power',
            () => {}
        );

        this._idleMonitor = global.backend.get_core_idle_monitor();
    }

    enable() {
        Main.screenShield._setActive = _hookedSetActive;
        Main.screenShield._activateFade = _hookedActivateFade;
        Main.screenShield._resetLockScreen = _hookedResetLockScreen;
        Main.screenShield._onUserBecameActive = _hookedOnUserBecameActive;
        Main.screenShield._refreshBackground = _hookedRefreshBackground;

        // Always keep lockDialogGroup black — it's the layer behind blurred backgrounds
        Main.screenShield._lockDialogGroup.set_style('background-color: black;');
    }

    disable() {
        Main.screenShield._setActive = this._origSetActive;
        Main.screenShield._activateFade = this._origActivateFade;
        Main.screenShield._resetLockScreen = this._origResetLockScreen;
        Main.screenShield._onUserBecameActive = this._origOnUserBecameActive;
        Main.screenShield._refreshBackground = this._origRefreshBackground;

        // Restore original lockDialogGroup style by re-running the original method
        this._origRefreshBackground.call(Main.screenShield);

        if (this._powerSignalId !== 0) {
            this._powerProxy.disconnect(this._powerSignalId);
            this._powerSignalId = 0;
        }

        this._clearAODTimeout();
        this._clearIdleWatch();
        this._clearUserActiveWatch();

        if (this._inAOD)
            this._exitAOD({animate: false});
    }

    isAODEnabled() {
        if (this._settings.get_boolean('disable-on-battery') && this._isOnBattery())
            return false;
        return true;
    }

    _isOnBattery() {
        try {
            return this._powerProxy.OnBattery;
        } catch {
            return false;
        }
    }

    _onPowerChanged() {
        if (!this._inLock)
            return;

        if (this._isOnBattery() && this._settings.get_boolean('disable-on-battery')) {
            // Switched to battery while in AOD — blank the screen normally
            this._blankScreenNormally();
        } else if (!this._isOnBattery() && this._inLock && !this._inAOD) {
            // Switched to AC while locked — enter AOD
            this._turnOnMonitor();
            this._enterAOD();
        }
    }

    // Blank the vanilla way: active-changed makes gnome-settings-daemon turn
    // the display off. _screenBlanked keeps _setActive from re-emitting it.
    _blankScreenNormally() {
        if (this._inAOD)
            this._exitAOD({animate: false});

        if (Main.screenShield._isActive && !this._screenBlanked) {
            Main.screenShield.emit('active-changed');
            this._screenBlanked = true;
        }
    }

    _enterAOD() {
        if (this._inAOD)
            return;

        this._inAOD = true;
        console.debug('AOD: entering AOD mode');

        // Turn off any active lightboxes that may be covering the lock screen
        const ss = Main.screenShield;
        ss._longLightbox.lightOff();
        ss._shortLightbox.lightOff();

        const dialog = ss._dialog;
        if (dialog && dialog._backgroundGroup) {
            const fadeInTime = this._settings.get_int('fade-in-time');
            console.debug(`AOD: fading background to black over ${fadeInTime}ms`);
            dialog._backgroundGroup.remove_all_transitions();
            dialog._backgroundGroup.ease({
                opacity: 0,
                duration: fadeInTime,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            console.debug(`AOD: no dialog or backgroundGroup found (dialog=${!!dialog})`);
        }

        this._reduceBrightness();
        this._startAODTimeout();
        this._clearIdleWatch();
        this._setupUserActiveWatch();
    }

    _exitAOD({animate = true} = {}) {
        if (animate && !this._inAOD)
            return;

        this._inAOD = false;
        console.debug(`AOD: exiting AOD mode (animate=${animate})`);

        const dialog = Main.screenShield._dialog;
        if (dialog && dialog._backgroundGroup) {
            dialog._backgroundGroup.remove_all_transitions();
            if (animate) {
                dialog._backgroundGroup.ease({
                    opacity: 255,
                    duration: this._settings.get_int('fade-out-time'),
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                });
            } else {
                dialog._backgroundGroup.opacity = 255;
            }
        }

        this._restoreBrightness();
        this._clearAODTimeout();
        this._clearUserActiveWatch();

        // Animated exit means the user is interacting: re-arm the idle watch.
        // Immediate exit means the lock screen is going away — drop it.
        if (animate)
            this._setupIdleWatch();
        else
            this._clearIdleWatch();
    }

    _reduceBrightness() {
        try {
            const currentBrightness = this._brightnessProxy.Brightness;
            if (currentBrightness >= 0) {
                this._savedBrightness = currentBrightness;
                const reduction = this._settings.get_int('brightness-reduction');
                const targetBrightness = Math.max(1, Math.round(currentBrightness * reduction / 100));
                this._brightnessProxy.Brightness = targetBrightness;
            }
        } catch {
            // Brightness control not available (e.g. desktop without backlight)
        }
    }

    _restoreBrightness() {
        if (this._savedBrightness < 0)
            return;

        try {
            this._brightnessProxy.Brightness = this._savedBrightness;
        } catch {
            // Ignore
        }
        this._savedBrightness = -1;
    }

    _turnOnMonitor() {
        try {
            this._displayProxy.PowerSaveMode = 0;
        } catch {
            // Ignore
        }
    }

    _startAODTimeout() {
        this._clearAODTimeout();

        const timeoutMinutes = this._settings.get_int('aod-timeout');
        if (timeoutMinutes <= 0)
            return;

        this._aodTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            timeoutMinutes * 60,
            () => {
                this._aodTimeoutId = 0;
                // AOD timeout expired — blank the screen
                this._blankScreenNormally();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _clearAODTimeout() {
        if (this._aodTimeoutId !== 0) {
            GLib.Source.remove(this._aodTimeoutId);
            this._aodTimeoutId = 0;
        }
    }

    _setupIdleWatch() {
        this._clearIdleWatch();

        if (!this._inLock || this._inAOD)
            return;

        // Re-enter AOD after idle period on the lock screen
        const idleDelaySec = this._settings.get_int('idle-delay');
        this._idleWatchId = this._idleMonitor.add_idle_watch(
            idleDelaySec * 1000,
            () => {
                this._idleWatchId = 0;
                if (this._inLock && !this._inAOD && this.isAODEnabled())
                    this._enterAOD();
            }
        );
    }

    _clearIdleWatch() {
        if (this._idleWatchId !== 0) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }
    }

    _setupUserActiveWatch() {
        this._clearUserActiveWatch();

        // Watch for user activity to exit AOD
        this._userActiveWatchId = this._idleMonitor.add_user_active_watch(
            () => {
                this._userActiveWatchId = 0;
                if (this._inAOD)
                    this._exitAOD();
            }
        );
    }

    _clearUserActiveWatch() {
        if (this._userActiveWatchId !== 0) {
            this._idleMonitor.remove_watch(this._userActiveWatchId);
            this._userActiveWatchId = 0;
        }
    }

    onLockScreenActivated() {
        this._inLock = true;
        this._screenBlanked = false;
        console.debug('AOD: lock screen activated');

        // Enter AOD immediately — mirrors the original behavior where
        // gnome-settings-daemon would blank the display at this point
        if (this.isAODEnabled() && !this._inAOD)
            this._enterAOD();
    }

    onLockScreenDeactivated() {
        this._inLock = false;
        this._screenBlanked = false;
        if (this._inAOD)
            this._exitAOD({animate: false});
    }
}

// --- Hooked ScreenShield methods ---
// These run with `this` bound to Main.screenShield

function _hookedRefreshBackground() {
    // Call the original, which sets _lockDialogGroup style from login-screen settings
    aod._origRefreshBackground.call(this);
    // Override with black background
    this._lockDialogGroup.set_style('background-color: black;');
}

function _hookedSetActive(active) {
    let prevIsActive = this._isActive;
    this._isActive = active;

    if (active)
        aod.onLockScreenActivated();
    else
        aod.onLockScreenDeactivated();

    if (prevIsActive !== this._isActive) {
        if (!aod.isAODEnabled() || aod._screenBlanked) {
            console.debug('AOD: emitting active-changed');
            this.emit('active-changed');
            aod._screenBlanked = false;
        } else {
            console.debug('AOD: suppressing active-changed (keeping display on)');
        }
    }

    this._syncInhibitor();
}

function _hookedActivateFade(lightbox, time) {
    if (aod._inLock) {
        // Already on lock screen — enter AOD instead of fading to black
        if (aod.isAODEnabled()) {
            aod._enterAOD();
        } else {
            // AOD disabled (e.g. on battery) — use original fade
            aod._origActivateFade.call(this, lightbox, time);
        }
        return;
    }

    // Not yet locked (session going idle) — do the normal fade
    // but intercept the lightbox completion to prevent blanking
    Main.uiGroup.set_child_above_sibling(lightbox, null);

    if (aod.isAODEnabled()) {
        // Show the lightbox fade but then hide it once lock screen is ready
        lightbox.lightOn(time);

        if (this._becameActiveId === 0) {
            this._becameActiveId = this.idleMonitor.add_user_active_watch(
                this._onUserBecameActive.bind(this));
        }
    } else {
        // AOD disabled — original behavior
        aod._origActivateFade.call(this, lightbox, time);
    }
}

function _hookedOnUserBecameActive() {
    if (this._becameActiveId !== 0) {
        this.idleMonitor.remove_watch(this._becameActiveId);
        this._becameActiveId = 0;
    }

    if (this._isActive || this._isLocked) {
        // Turn off lightboxes
        this._longLightbox.lightOff();
        this._shortLightbox.lightOff();

        // Exit AOD if active — returns to clock view with blurred background
        if (aod._inAOD)
            aod._exitAOD();
    } else {
        this.deactivate(false);
    }
}

function _hookedResetLockScreen(params) {
    if (this._lockScreenState !== MessageTray.State.HIDDEN)
        return;

    this._lockScreenGroup.show();
    this._lockScreenState = MessageTray.State.SHOWING;

    let fadeToBlack = aod.isAODEnabled() ? false : params.fadeToBlack;

    if (params.animateLockScreen) {
        this._lockDialogGroup.translation_y = -global.screen_height;
        this._lockDialogGroup.remove_all_transitions();
        this._lockDialogGroup.ease({
            translation_y: 0,
            duration: Overview.ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._lockScreenShown({fadeToBlack, animateFade: true});
            },
        });
    } else {
        this._lockDialogGroup.translation_y = 0;
        this._lockScreenShown({fadeToBlack, animateFade: false});
    }

    this._dialog.grab_key_focus();
}

// --- Extension entry point ---

export default class AlwaysOnDisplayExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        if (aod !== null)
            return;

        aod = new AlwaysOnDisplay(this._settings);
        aod.enable();
    }

    disable() {
        // GNOME calls disable() on the switch to the lock screen, where AOD
        // must keep running — clean up only once the session leaves it.
        if (!Main.sessionMode.isLocked) {
            if (aod !== null) {
                aod.disable();
                aod = null;
            }
            this._settings = null;
        }
    }
}
