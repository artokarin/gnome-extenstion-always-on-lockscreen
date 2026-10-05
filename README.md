# Always On Display — GNOME Shell Extension

Shows clock/date/notifications on a black background instead of turning off the display on the lock screen, similar to AOD on smartphones. Looks especially good on OLED displays.

## How it works

When the screen locks, GNOME normally turns off the display via DPMS. This extension intercepts that behavior: the display stays on, the wallpaper fades to black, and the lock screen clock and notifications remain visible at reduced brightness.

Any mouse or keyboard input exits AOD and returns to the normal lock screen (with blurred background).

After a configurable idle period on the lock screen, AOD re-activates automatically.

## Features

- Smooth fade-in/fade-out animations when entering/exiting AOD
- Automatic brightness reduction in AOD mode (and even set it back)
- Software dimming as an alternative to the backlight, for OLED panels and for displays with no brightness control at all
- Configurable AOD timeout (should DPMS poweroff after N minutes, disabled by default)
- Configurable idle delay before AOD re-activates
- Battery-aware: optionally disables AOD on battery power
- OLED protection: the clock, date and notifications glide to a new random position every interval (12 px, 60 s by default), like the "Screen Shift" feature of OLED TVs, so no pixel stays lit in the same place; the black background is not moved
- Reacts to power source changes in real time (AC plugged in → AOD on, unplugged → screen blanks)

## Install

```bash
git clone https://github.com/artokarin/gnome-extenstion-always-on-lockscreen.git
cd gnome-extenstion-always-on-lockscreen
make install
```

Then log out and log back in (Wayland) or restart GNOME Shell (X11 — GNOME 50 dropped the X11 session, so there a re-login is the only option).

Enable the extension:

```bash
gnome-extensions enable always-on-display@art.okarin@yandex.ru
```

### Uninstall

```bash
make uninstall
```

## Requirements

- GNOME Shell 46 to 50
- GLib, Clutter, Gio (bundled with GNOME)

## License

This project is free software. See the LICENSE for details
