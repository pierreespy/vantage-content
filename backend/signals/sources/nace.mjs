// Vantage — the MedTech activity codes, once, for every registry connector.
//
// Every European business register classifies activity with a national
// derivation of NACE Rev. 2, so the same five activities carry a different
// code format per country. Keeping one canonical list here means "what counts
// as MedTech" is decided in a single place; each connector only formats it.
//
//   NACE   Activity                                        FR (NAF)      UK (SIC 2007)  NO/NACE
//   21.20  Pharmaceutical preparations                     2120Z         21200          21.20
//   26.60  Irradiation & electromedical equipment          2660Z         26600          26.60
//   32.50  Medical and dental instruments                  3250A/3250B   32500          32.50
//   72.11  Biotechnology R&D                               7211Z         72110          72.11
//   72.19  Other natural-science R&D                       7219Z         72190          72.19
//
// `62.01` (software) is deliberately absent everywhere: it would flood the
// pipeline with every SaaS incorporation on the continent. Adding it needs a
// keyword filter alongside.

/** Canonical NACE Rev. 2 classes, dotted. The source of truth. */
export const MEDTECH_NACE = ['21.20', '26.60', '32.50', '72.11', '72.19'];

/**
 * France — NAF/APE. Not derivable from NACE: the national level adds a letter,
 * and 32.50 splits into 3250A (instruments) and 3250B (dental prosthetics).
 */
export const MEDTECH_NAF = ['2120Z', '2660Z', '3250A', '3250B', '7211Z', '7219Z'];

/** United Kingdom — SIC 2007, five digits: the NACE class with a trailing 0. */
export const MEDTECH_SIC = MEDTECH_NACE.map((code) => `${code.replace('.', '')}0`);

/** Norway — NACE as published by Brønnøysund, dotted. Their `naeringskode`
 *  filter matches on prefix, so the 2-decimal class covers its sub-codes
 *  (32.50 also returns 32.500). */
export const MEDTECH_NACE_NO = MEDTECH_NACE;
