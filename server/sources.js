// Sources whose asset "ticker" is a free-text label rather than an ISIN: these
// funds publish a single NAV series on their own site (one page per comparto),
// so there is nothing to look up by ISIN and the format check must be skipped.
export const NON_ISIN_SOURCES = new Set(['COMETA', 'ALIFOND']);
