/**
 * Shades for value that sits at one level but belongs to another.
 *
 * The pyramid gives each goal a colour. When a portfolio is merged into a
 * parent/child group whose parent lives at a different goal, its value moves to
 * the parent's level — it is still that level's money, so it must stay
 * recognisably that level's colour, but it is on loan from somewhere else, so
 * it must not read as native either. Hence a tint of the host colour rather
 * than a colour of its own: same hue, lighter and less saturated.
 *
 * Every renderer of that overlap (the Apex funnel, the goal target bar, the
 * legends) calls this, so one inherited slice looks the same everywhere.
 */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Rgb { r: number; g: number; b: number }

/** Accepts '#rgb', '#rrggbb' and 'rgb()/rgba()'. Returns null on anything else. */
const parseColor = (color: string): Rgb | null => {
    const value = color.trim();

    const hex = value.replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex)) {
        return {
            r: parseInt(hex[0] + hex[0], 16),
            g: parseInt(hex[1] + hex[1], 16),
            b: parseInt(hex[2] + hex[2], 16),
        };
    }
    if (/^[0-9a-f]{6}$/i.test(hex)) {
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
        };
    }

    const rgb = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (rgb) {
        return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
    }

    return null;
};

const toHex = (c: Rgb): string => {
    const part = (v: number) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, '0');
    return `#${part(c.r)}${part(c.g)}${part(c.b)}`;
};

/** How far each successive inherited slice is pushed toward white. */
const STEP = 0.26;
const MAX_MIX = 0.72;

/**
 * A tint of `color` for the `index`-th foreign goal borrowing this level.
 *
 * The first inherited slice is clearly lighter than the level itself; further
 * ones keep stepping, capped short of white so the last one is still readable
 * against the label text drawn on top of it. An unparseable colour is returned
 * untouched rather than replaced with a guess — a wrong-hue slice would read as
 * a different goal entirely, which is the one thing this must never do.
 */
export const tintForInherited = (color: string, index = 0): string => {
    const base = parseColor(color);
    if (!base) return color;

    const mix = Math.min(MAX_MIX, STEP * (index + 1));
    return toHex({
        r: base.r + (255 - base.r) * mix,
        g: base.g + (255 - base.g) * mix,
        b: base.b + (255 - base.b) * mix,
    });
};
