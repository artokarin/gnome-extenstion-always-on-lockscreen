// Always On Display: keeps the lock screen visible on a dimmed black
// background instead of letting the display blank.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {UnlockDialog} from 'resource:///org/gnome/shell/ui/unlockDialog.js';

const DisplayConfigIface = `<node>
<interface name="org.gnome.Mutter.DisplayConfig">
    <property name="PowerSaveMode" type="i" access="readwrite"/>
</interface>
</node>`;
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);

const UPowerIface = `<node>
<interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
</interface>
</node>`;
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerIface);

// GNOME 46-48 only: gnome-settings-daemon dropped this interface in 49, where
// the shell's own BrightnessManager took over the backlight.
const BrightnessIface = `<node>
<interface name="org.gnome.SettingsDaemon.Power.Screen">
    <property name="Brightness" type="i" access="readwrite"/>
</interface>
</node>`;
const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(BrightnessIface);

function onProxyReady(proxy, error) {
    if (error)
        logError(error, 'Always On Display');
}

class AlwaysOnDisplay {
    constructor(settings) {
        this._settings = settings;
        this._injectionManager = new InjectionManager();
        this._idleMonitor = global.backend.get_core_idle_monitor();

        this._inAOD = false;
        this._inLock = false;
        this._screenBlanked = false;
        this._dimOverlay = null;
        this._savedBrightness = null;
        this._savedDimming = null;
        this._savedDimmingTarget = null;
        this._aodTimeoutId = 0;
        this._idleWatchId = 0;
        this._promptIdleWatchId = 0;
        this._userActiveWatchId = 0;

        this._displayProxy = new DisplayConfigProxy(Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            onProxyReady);

        this._powerProxy = new UPowerProxy(Gio.DBus.system,
            'org.freedesktop.UPower', '/org/freedesktop/UPower', onProxyReady);
        this._powerProxy.connectObject('g-properties-changed',
            () => this._onPowerChanged(), this);

        this._brightnessProxy = Main.brightnessManager
            ? null
            : new BrightnessProxy(Gio.DBus.session, 'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power', onProxyReady);
    }

    enable() {
        const controller = this;
        const ss = Main.screenShield;
        const im = this._injectionManager;

        // The shell blanks the display by emitting active-changed, which
        // gnome-settings-daemon turns into DPMS off. Making that emission
        // conditional is what keeps the display on.
        im.overrideMethod(ss, '_setActive', () => function (active) {
            const wasActive = this._isActive;
            this._isActive = active;

            if (active)
                controller._onLocked();
            else
                controller._onUnlocked();

            if (wasActive !== active && !controller._isAODEnabled())
                this.emit('active-changed');

            this._syncInhibitor();
        });

        // Fading the lock screen to black is exactly what AOD replaces.
        im.overrideMethod(ss, '_activateFade', original => function (lightbox, time) {
            if (controller._inLock && controller._isAODEnabled())
                controller._enterAOD();
            else
                original.call(this, lightbox, time);
        });

        // Same reason, for the fade the shell runs as it puts the lock screen up
        im.overrideMethod(ss, '_resetLockScreen', original => function (params) {
            original.call(this, {
                ...params,
                fadeToBlack: params.fadeToBlack && !controller._isAODEnabled(),
            });
        });

        // Input returns to the clock view rather than to a blank screen.
        im.overrideMethod(ss, '_onUserBecameActive', original => function () {
            original.call(this);
            if (controller._inAOD)
                controller._exitAOD();
        });

        // Not upstream: Ubuntu's configure_login_screen patch sets an inline
        // background style that would win over our stylesheet class.
        if (ss._refreshBackground) {
            im.overrideMethod(ss, '_refreshBackground', original => function () {
                original.call(this);
                this._lockDialogGroup.set_style(null);
            });
        }

        // On the prototype, since the dialog is recreated on every lock. This
        // catches the shell returning from the password prompt to the clock.
        if (UnlockDialog.prototype._showClock) {
            im.overrideMethod(UnlockDialog.prototype, '_showClock', original => function () {
                original.call(this);
                controller._setupIdleWatch();
            });
        }

        // The layer revealed once the lock screen backgrounds fade out
        ss._lockDialogGroup.set_style(null);
        ss._lockDialogGroup.add_style_class_name('aod-lock-background');
    }

    disable() {
        this._injectionManager.clear();
        this._powerProxy.disconnectObject(this);

        Main.screenShield._lockDialogGroup.remove_style_class_name('aod-lock-background');
        // Puts back the inline style the (now restored) original sets; there
        // is nothing to restore where Ubuntu's patch is absent.
        Main.screenShield._refreshBackground?.();

        this._exitAOD({animate: false});

        this._dimOverlay?.destroy();
        this._dimOverlay = null;
    }

    _isAODEnabled() {
        return !(this._settings.get_boolean('disable-on-battery') &&
                 this._powerProxy.OnBattery);
    }

    // The unlock dialog shows either the clock or the password prompt, and AOD
    // must only ever cover the clock.
    _isOnPromptScreen() {
        const dialog = Main.screenShield._dialog;
        return !!dialog && dialog._activePage === dialog._promptBox;
    }

    _onLocked() {
        this._inLock = true;
        this._screenBlanked = false;

        // Enter AOD right away: this is the point where the display would
        // otherwise blank.
        if (this._isAODEnabled())
            this._enterAOD();
    }

    _onUnlocked() {
        this._inLock = false;
        this._screenBlanked = false;
        this._exitAOD({animate: false});
    }

    _onPowerChanged() {
        if (!this._inLock)
            return;

        if (!this._isAODEnabled()) {
            this._blankScreenNormally();
        } else if (!this._inAOD) {
            // Back on AC, where the display is likely blanked already
            this._displayProxy.PowerSaveMode = 0;
            this._enterAOD();
        }
    }

    // Blank the vanilla way: active-changed makes gnome-settings-daemon turn
    // the display off. _screenBlanked keeps us from emitting it twice.
    _blankScreenNormally() {
        this._exitAOD({animate: false});

        if (Main.screenShield._isActive && !this._screenBlanked) {
            Main.screenShield.emit('active-changed');
            this._screenBlanked = true;
        }
    }

    _enterAOD() {
        if (this._inAOD || !this._inLock)
            return;

        if (this._isOnPromptScreen()) {
            this._setupIdleWatch();
            return;
        }

        this._inAOD = true;

        const ss = Main.screenShield;
        ss._longLightbox.lightOff();
        ss._shortLightbox.lightOff();

        this._fadeBackground({
            opacity: 0,
            duration: this._settings.get_int('fade-in-time'),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._dim();
        this._startAODTimeout();
        this._clearIdleWatch();

        this._userActiveWatchId = this._idleMonitor.add_user_active_watch(() => {
            this._userActiveWatchId = 0;
            this._exitAOD();
        });
    }

    _exitAOD({animate = true} = {}) {
        this._inAOD = false;

        this._fadeBackground({
            opacity: 255,
            duration: animate ? this._settings.get_int('fade-out-time') : 0,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });

        this._undim({animate});
        this._clearAODTimeout();
        this._clearUserActiveWatch();

        // An animated exit means the user is interacting, so AOD should come
        // back on idle; an immediate one means the lock screen is going away.
        if (animate)
            this._setupIdleWatch();
        else
            this._clearIdleWatch();
    }

    // Fading the dialog's own backgrounds out reveals the black
    // _lockDialogGroup behind them, leaving the clock and notifications.
    _fadeBackground(params) {
        const backgroundGroup = Main.screenShield._dialog?._backgroundGroup;
        if (!backgroundGroup)
            return;

        backgroundGroup.remove_all_transitions();
        if (params.duration > 0)
            backgroundGroup.ease(params);
        else
            backgroundGroup.opacity = params.opacity;
    }

    // The setting picks the mechanism, and neither stands in for the other:
    // the overlay only darkens the image, so outside OLED it emits just as
    // much light. _undim() undoes both, since the choice may have changed
    // while AOD was up.
    _dim() {
        if (!this._settings.get_boolean('software-dimming')) {
            this._dimBacklight();
            return;
        }

        const level = this._settings.get_int('brightness-reduction');
        if (level >= 100)
            return;

        // Black at alpha (1 - N%) is exactly an N% brightness scale
        this._ensureDimOverlay().ease({
            opacity: Math.round(255 * (1 - level / 100)),
            duration: this._settings.get_int('fade-in-time'),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _undim({animate = true} = {}) {
        if (this._dimOverlay) {
            // Assigning opacity mid-transition only retargets it
            this._dimOverlay.remove_transition('opacity');
            if (animate) {
                this._dimOverlay.ease({
                    opacity: 0,
                    duration: this._settings.get_int('fade-out-time'),
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                });
            } else {
                this._dimOverlay.opacity = 0;
            }
        }

        this._undimBacklight();
    }

    _dimBacklight() {
        const level = this._settings.get_int('brightness-reduction');
        const manager = Main.brightnessManager;

        if (!manager) {
            // A missing interface reads back as null, and null >= 0 is true,
            // hence the type test the shell's own brightness slider uses.
            const brightness = this._brightnessProxy.Brightness;
            if (!Number.isInteger(brightness) || brightness < 0)
                return;

            this._savedBrightness = brightness;
            this._brightnessProxy.Brightness =
                Math.max(1, Math.round(brightness * level / 100));
            return;
        }

        // GNOME 49+. A null scale means no monitor has a backlight.
        const scale = manager.globalScale;
        if (!scale)
            return;

        // dimming clips the backlight to _dimmingTarget instead of scaling it,
        // so the level has to go there or it is a no-op for anyone already
        // below it. That field is private, so fall back to the system dim
        // level rather than failing should it ever go away.
        if (typeof manager._dimmingTarget === 'number') {
            this._savedDimmingTarget = manager._dimmingTarget;
            manager._dimmingTarget = scale.value * level / 100;
        }

        // Assigning _dimmingTarget syncs nothing; the dimming setter does.
        this._savedDimming = manager.dimming;
        manager.dimming = true;
    }

    _undimBacklight() {
        if (this._savedBrightness !== null) {
            this._brightnessProxy.Brightness = this._savedBrightness;
            this._savedBrightness = null;
        }

        if (this._savedDimming === null)
            return;

        const manager = Main.brightnessManager;

        // Restore the target first: the dimming setter below is what syncs the
        // backlight, and leaving ours behind would quietly apply it to the
        // system's own idle dim until the next shell restart.
        if (this._savedDimmingTarget !== null) {
            manager._dimmingTarget = this._savedDimmingTarget;
            this._savedDimmingTarget = null;
        }

        // Back to what it was, not to false: the session may have been idle
        // dimming already when the screen locked.
        manager.dimming = this._savedDimming;
        this._savedDimming = null;
    }

    // A black actor of our own, covering every monitor. Setting opacity on the
    // shell's actors instead does not work: the top panel is shared chrome.
    _ensureDimOverlay() {
        if (!this._dimOverlay) {
            this._dimOverlay = new St.Widget({
                style_class: 'aod-dim-overlay',
                // Input has to pass through: it is what ends AOD
                reactive: false,
                opacity: 0,
            });
            this._dimOverlay.add_constraint(new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }));
            Main.uiGroup.add_child(this._dimOverlay);
        }

        // Other extensions reorder uiGroup, so claim the top on every dim
        Main.uiGroup.set_child_above_sibling(this._dimOverlay, null);
        return this._dimOverlay;
    }

    _startAODTimeout() {
        this._clearAODTimeout();

        const timeoutMinutes = this._settings.get_int('aod-timeout');
        if (timeoutMinutes <= 0)
            return;

        this._aodTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            timeoutMinutes * 60, () => {
                this._aodTimeoutId = 0;
                this._blankScreenNormally();
                return GLib.SOURCE_REMOVE;
            });
    }

    _clearAODTimeout() {
        if (this._aodTimeoutId !== 0) {
            GLib.Source.remove(this._aodTimeoutId);
            this._aodTimeoutId = 0;
        }
    }

    // Bring AOD back once the lock screen goes idle again. On the password
    // prompt, wait for input instead: an idle watch there would fire straight
    // back into _enterAOD() and spin, since AOD must not cover the prompt.
    _setupIdleWatch() {
        this._clearIdleWatch();

        if (!this._inLock || this._inAOD)
            return;

        if (this._isOnPromptScreen()) {
            this._promptIdleWatchId = this._idleMonitor.add_user_active_watch(() => {
                this._promptIdleWatchId = 0;
                this._setupIdleWatch();
            });
            return;
        }

        this._idleWatchId = this._idleMonitor.add_idle_watch(
            this._settings.get_int('idle-delay') * 1000, () => {
                // Unlike a user-active watch, an idle watch stays registered
                // and fires again on the next idle, so drop it by hand.
                this._clearIdleWatch();
                if (this._isAODEnabled())
                    this._enterAOD();
            });
    }

    _clearIdleWatch() {
        if (this._idleWatchId !== 0) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }
        if (this._promptIdleWatchId !== 0) {
            this._idleMonitor.remove_watch(this._promptIdleWatchId);
            this._promptIdleWatchId = 0;
        }
    }

    _clearUserActiveWatch() {
        if (this._userActiveWatchId !== 0) {
            this._idleMonitor.remove_watch(this._userActiveWatchId);
            this._userActiveWatchId = 0;
        }
    }
}

export default class AlwaysOnDisplayExtension extends Extension {
    enable() {
        this._aod = new AlwaysOnDisplay(this.getSettings());
        this._aod.enable();
    }

    disable() {
        // The unlock-dialog session mode is required: this extension exists to
        // replace what the shell does while the screen is locked, so it has to
        // keep running there.
        this._aod.disable();
        this._aod = null;
    }
}
