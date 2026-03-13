UUID = always-on-display@art.okarin@yandex.ru
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR = $(UUID)/schemas

.PHONY: all schemas install uninstall restart

all: schemas install restart

schemas:
	glib-compile-schemas $(SCHEMA_DIR)

install: schemas
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	cp -r $(UUID)/* $(INSTALL_DIR)/

uninstall:
	rm -rf $(INSTALL_DIR)

restart:
	@echo "Restarting GNOME Shell (Wayland: re-login required)..."
	@if [ "$$XDG_SESSION_TYPE" = "x11" ]; then \
		busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…")'; \
	else \
		echo "On Wayland, log out and log back in to apply changes."; \
	fi
