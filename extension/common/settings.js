/** Returns a boolean setting, with an explicit default for older installations. */
const settingEnabled = (settings, name, defaultValue = true) => settings[name] ?? defaultValue;
