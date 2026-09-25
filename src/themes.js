// The registry both the CLI and the browser read from, so adding a theme is this list
// plus a matching `:root[data-theme='<id>']` block in public/style.css — and nothing
// else. The dropdown builds itself from here, and `--theme` validates against it.
//
// Every theme is free to reshape form, but not to spend colour on chrome: the five
// state hues are the only signal this tool has, and a theme that decorated with them
// would be trading away the thing it exists to show.
export const THEMES = [
  { id: 'graphite', label: 'Graphite', note: 'monochrome dark — the default' },
  { id: 'montgomery', label: 'Montgomery brutalist', note: 'béton brut, warm concrete' },
  { id: 'neo', label: 'Neo-brutalism', note: 'bone paper, hard shadows' },
  { id: 'acid', label: 'Acid brutalism', note: 'near-black, acid lime' },
];

export const THEME_IDS = THEMES.map((theme) => theme.id);

export const DEFAULT_THEME = THEME_IDS[0];

export const isTheme = (name) => THEME_IDS.includes(name);
