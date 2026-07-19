import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

        const brightnessRow = new Adw.ActionRow({
            title: _('AOD brightness (%)'),
            subtitle: _('Screen brightness level in AOD mode'),
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
