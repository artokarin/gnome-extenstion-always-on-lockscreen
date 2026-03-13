import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AlwaysOnDisplayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Always On Display',
            icon_name: 'display-brightness-symbolic',
        });
        window.add(page);

        // General group
        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
        });
        page.add(generalGroup);

        // Disable on battery
        const batteryRow = new Adw.SwitchRow({
            title: 'Disable on battery',
            subtitle: 'Turn off AOD when running on battery power',
        });
        settings.bind('disable-on-battery', batteryRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(batteryRow);

        // AOD timeout
        const timeoutRow = new Adw.SpinRow({
            title: 'AOD timeout (minutes)',
            subtitle: '0 = stay on indefinitely',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 480,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('aod-timeout'),
            }),
        });
        timeoutRow.adjustment.connect('value-changed', () => {
            settings.set_int('aod-timeout', timeoutRow.adjustment.value);
        });
        generalGroup.add(timeoutRow);

        // Display group
        const displayGroup = new Adw.PreferencesGroup({
            title: 'Display',
        });
        page.add(displayGroup);

        // Brightness reduction
        const brightnessRow = new Adw.ActionRow({
            title: 'AOD brightness (%)',
            subtitle: 'Screen brightness level in AOD mode',
        });
        const brightnessScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
                value: settings.get_int('brightness-reduction'),
            }),
            hexpand: true,
            valign: Gtk.Align.CENTER,
            draw_value: true,
            digits: 0,
        });
        brightnessScale.set_size_request(200, -1);
        brightnessScale.adjustment.connect('value-changed', () => {
            settings.set_int('brightness-reduction', brightnessScale.adjustment.value);
        });
        brightnessRow.add_suffix(brightnessScale);
        displayGroup.add(brightnessRow);

        // Animation group
        const animGroup = new Adw.PreferencesGroup({
            title: 'Animation',
        });
        page.add(animGroup);

        // Fade-in time
        const fadeInRow = new Adw.SpinRow({
            title: 'Fade-in time (ms)',
            subtitle: 'Duration of fade when entering AOD',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 5000,
                step_increment: 100,
                page_increment: 500,
                value: settings.get_int('fade-in-time'),
            }),
        });
        fadeInRow.adjustment.connect('value-changed', () => {
            settings.set_int('fade-in-time', fadeInRow.adjustment.value);
        });
        animGroup.add(fadeInRow);

        // Fade-out time
        const fadeOutRow = new Adw.SpinRow({
            title: 'Fade-out time (ms)',
            subtitle: 'Duration of fade when exiting AOD',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 2000,
                step_increment: 50,
                page_increment: 100,
                value: settings.get_int('fade-out-time'),
            }),
        });
        fadeOutRow.adjustment.connect('value-changed', () => {
            settings.set_int('fade-out-time', fadeOutRow.adjustment.value);
        });
        animGroup.add(fadeOutRow);
    }
}
