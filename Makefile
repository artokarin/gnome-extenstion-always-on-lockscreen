UUID = always-on-display@art.okarin@yandex.ru
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR = $(UUID)/schemas
GETTEXT_DOMAIN = $(UUID)

.PHONY: all schemas locale pot install uninstall restart zip

all: schemas install restart

schemas:
	glib-compile-schemas $(SCHEMA_DIR)

# Compile po/*.po into $(UUID)/locale/<lang>/LC_MESSAGES/<domain>.mo
locale:
	@for po in po/*.po; do \
		[ -e "$$po" ] || continue; \
		lang=$$(basename "$$po" .po); \
		mkdir -p "$(UUID)/locale/$$lang/LC_MESSAGES"; \
		msgfmt -o "$(UUID)/locale/$$lang/LC_MESSAGES/$(GETTEXT_DOMAIN).mo" "$$po"; \
	done

# Regenerate the translation template from the sources
pot:
	xgettext --from-code=UTF-8 --package-name="Always On Display" \
		--output=po/always-on-display.pot \
		$(UUID)/prefs.js $(UUID)/extension.js

install: schemas locale
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	cp -r $(UUID)/* $(INSTALL_DIR)/

uninstall:
	rm -rf $(INSTALL_DIR)

zip: schemas locale
	cd $(UUID) && zip -r ../$(UUID).zip . -x "schemas/gschemas.compiled"

restart:
	@echo "Restarting GNOME Shell (Wayland: re-login required)..."
	@if [ "$$XDG_SESSION_TYPE" = "x11" ]; then \
		busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…")'; \
	else \
		echo "On Wayland, log out and log back in to apply changes."; \
	fi
