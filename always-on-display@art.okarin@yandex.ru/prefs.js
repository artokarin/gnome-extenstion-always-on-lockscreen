import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function _getProperty(name, path, iface, prop, callback) {
    Gio.DBus.session.call(
        name, path, 'org.freedesktop.DBus.Properties', 'Get',
        new GLib.Variant('(ss)', [iface, prop]),
        null, Gio.DBusCallFlags.NONE, 2000, null,
        (bus, result) => {
            try {
                const [value] = bus.call_finish(result).recursiveUnpack();
                callback(value);
            } catch {
                callback(null);
            }
        });
}

// Whether the display has a backlight to turn down. Prefs runs in its own
// process and cannot look at the shell's BrightnessManager, so ask D-Bus:
// GNOME 49+ answers on org.gnome.Shell.Brightness, 46-48 on
// gnome-settings-daemon, whose interface 49 removed.
function _hasBacklight(callback) {
    _getProperty('org.gnome.Shell.Brightness', '/org/gnome/Shell/Brightness',
        'org.gnome.Shell.Brightness', 'HasBrightnessControl', shellAnswer => {
            if (typeof shellAnswer === 'boolean') {
                callback(shellAnswer);
                return;
            }
            _getProperty('org.gnome.SettingsDaemon.Power', '/org/gnome/SettingsDaemon/Power',
                'org.gnome.SettingsDaemon.Power.Screen', 'Brightness', level => {
                    // Nobody answered: assume a backlight rather than greying
                    // out a control that may well work.
                    callback(level === null ? true : Number.isInteger(level) && level >= 0);
                });
        });
}

// Read the <range> of an integer key from the GSettings schema, so the
// bounds live in one place only
function _getIntRange(settings, key) {
    const [type, value] = settings.settings_schema.get_key(key).get_range().deep_unpack();
    if (type !== 'range')
        throw new Error(`Schema key '${key}' has no range`);
    return value.deep_unpack();
}

function _addSpinRow(group, settings, key, {title, subtitle, step = 1, page = 10}) {
    const [lower, upper] = _getIntRange(settings, key);
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: page,
        }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

export default class AlwaysOnDisplayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Always On Display'),
            icon_name: 'display-brightness-symbolic',
        });
        window.add(page);

        // General group
        const generalGroup = new Adw.PreferencesGroup({
            title: _('General'),
        });
        page.add(generalGroup);

        const batteryRow = new Adw.SwitchRow({
            title: _('Disable on battery'),
            subtitle: _('Turn off AOD when running on battery power'),
        });
        settings.bind('disable-on-battery', batteryRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(batteryRow);

        _addSpinRow(generalGroup, settings, 'aod-timeout', {
            title: _('AOD timeout (minutes)'),
            subtitle: _('0 = stay on indefinitely'),
        });

        _addSpinRow(generalGroup, settings, 'idle-delay', {
            title: _('Idle delay (seconds)'),
            subtitle: _('Inactivity time before AOD re-activates on lock screen'),
        });

        // Display group
        const displayGroup = new Adw.PreferencesGroup({
            title: _('Display'),
        });
        page.add(displayGroup);

        const softwareDimRow = new Adw.SwitchRow({
            title: _('Software dimming'),
        });
        settings.bind('software-dimming', softwareDimRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(softwareDimRow);

        const brightnessRow = new Adw.ActionRow({
            title: _('AOD brightness (%)'),
        });
        const [brightnessLower, brightnessUpper] = _getIntRange(settings, 'brightness-reduction');
        const brightnessScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: brightnessLower,
                upper: brightnessUpper,
                step_increment: 5,
                page_increment: 10,
            }),
            hexpand: true,
            valign: Gtk.Align.CENTER,
            draw_value: true,
            digits: 0,
        });
        brightnessScale.set_size_request(200, -1);
        settings.bind('brightness-reduction', brightnessScale.adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        brightnessRow.add_suffix(brightnessScale);
        displayGroup.add(brightnessRow);

        // Without a backlight there is nothing for hardware dimming to turn
        // down, and the overlay must not stand in for it silently: it only
        // darkens the image, which lowers actual light output on OLED alone.
        // So say so, and leave the level unreachable until the user opts in.
        let hasBacklight = true;
        const syncDimmingRows = () => {
            brightnessRow.sensitive =
                settings.get_boolean('software-dimming') || hasBacklight;
            brightnessRow.subtitle = brightnessRow.sensitive
                ? _('Level in AOD mode, for the selected dimming method')
                : _('Unavailable: this display has no backlight control. Turn on software dimming to dim it.');
            softwareDimRow.subtitle = hasBacklight
                ? _('Dims the lock screen image instead of the backlight. Only OLED panels emit less light this way.')
                : _('This display has no backlight control, so this is the only way to dim it.');
        };

        syncDimmingRows();
        settings.connect('changed::software-dimming', () => syncDimmingRows());
        _hasBacklight(available => {
            hasBacklight = available;
            syncDimmingRows();
        });

        // Animation group
        const animGroup = new Adw.PreferencesGroup({
            title: _('Animation'),
        });
        page.add(animGroup);

        _addSpinRow(animGroup, settings, 'fade-in-time', {
            title: _('Fade-in time (ms)'),
            subtitle: _('Duration of fade when entering AOD'),
            step: 100,
            page: 500,
        });

        _addSpinRow(animGroup, settings, 'fade-out-time', {
            title: _('Fade-out time (ms)'),
            subtitle: _('Duration of fade when exiting AOD'),
            step: 50,
            page: 100,
        });
    }
}
