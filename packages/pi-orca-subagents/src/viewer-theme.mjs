const PALETTES = Object.freeze({
  dark: Object.freeze({
    cyan: "83;211;255",
    mint: "99;225;190",
    violet: "178;132;255",
    periwinkle: "139;167;255",
    amber: "255;193;92",
    blue: "101;175;255",
    magenta: "231;139;250",
    turquoise: "77;212;198",
    orange: "255;180;84",
    rose: "255;122;162",
    coral: "255;140;105",
    yellow: "244;211;94",
    green: "92;225;161",
    red: "255;112;122",
    slate: "112;126;148",
    foreground: "226;232;240",
    headerSurface: "37;41;49",
    surface: "31;37;50",
    dock: "23;29;43",
  }),
  light: Object.freeze({
    cyan: "0;101;128",
    mint: "0;112;86",
    violet: "98;57;163",
    periwinkle: "69;83;171",
    amber: "151;83;0",
    blue: "0;91;177",
    magenta: "151;49;170",
    turquoise: "0;116;107",
    orange: "162;82;0",
    rose: "178;39;91",
    coral: "172;61;31",
    yellow: "133;98;0",
    green: "0;118;73",
    red: "180;35;48",
    slate: "82;91;108",
    foreground: "30;36;48",
    headerSurface: "238;240;244",
    surface: "244;246;250",
    dock: "232;236;243",
  }),
});

const EVENT_ACCENTS = Object.freeze({
  prompt: "cyan",
  assistant: "mint",
  thinking: "violet",
  reasoning: "periwinkle",
  user: "amber",
  task: "amber",
  read: "blue",
  grep: "magenta",
  find: "turquoise",
  ls: "turquoise",
  bash: "orange",
  edit: "rose",
  write: "coral",
  extension: "yellow",
  success: "green",
  failed: "red",
  failure: "red",
  lifecycle: "slate",
  unknown: "slate",
  stderr: "red",
});

function normalizedKind(value) {
  return String(value ?? "unknown")
    .trim()
    .toLowerCase();
}

function accentName(kind) {
  const normalized = normalizedKind(kind);
  if (Object.hasOwn(EVENT_ACCENTS, normalized))
    return EVENT_ACCENTS[normalized];
  if (normalized.startsWith("extension")) return "yellow";
  return "slate";
}

function eventColor(kind, mode = "dark") {
  const palette = PALETTES[mode] || PALETTES.dark;
  return palette[accentName(kind)];
}

function sgr(code, resetCode, text, enabled) {
  return enabled && text ? `\x1b[${code}m${text}\x1b[${resetCode}m` : text;
}

export function createTheme(
  mode = "dark",
  { color = true, conservative = false } = {},
) {
  const selectedMode = mode === "light" ? "light" : "dark";
  const palette = PALETTES[selectedMode];
  const enabled = color !== false;
  const foreground = palette.foreground;
  const headerSurface = conservative ? foreground : palette.headerSurface;
  const surface = conservative ? foreground : palette.surface;
  const dock = conservative ? foreground : palette.dock;

  return Object.freeze({
    mode: selectedMode,
    color: enabled,
    conservative: conservative === true,
    foreground,
    headerSurface,
    surface,
    dock,
    muted: palette.slate,
    prompt: palette.cyan,
    structural: palette.violet,
    success: palette.green,
    failure: palette.red,
    eventColor(kind) {
      return eventColor(kind, selectedMode);
    },
    fg(text, rgb = foreground) {
      return sgr(`38;2;${rgb}`, "39", text, enabled);
    },
    bg(text, rgb = surface) {
      if (!enabled || conservative) return text;
      return sgr(`48;2;${rgb}`, "49", text, true);
    },
    bold(text) {
      return sgr("1", "22", text, enabled);
    },
  });
}

export function modeFromBackground(color) {
  if (
    !color ||
    !Number.isFinite(color.r) ||
    !Number.isFinite(color.g) ||
    !Number.isFinite(color.b)
  )
    return null;
  const luminance =
    (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
  return luminance >= 0.55 ? "light" : "dark";
}
