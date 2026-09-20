/**
 * Historical Correction (blueprint 15.3, 30.22; ADR 0010).
 *
 * `Edit → Review changes → Confirm correction`, for the revisions that rewrite
 * a month that is already closed, and for the ordinary-looking saves whose
 * dormant-episode consequence reaches one.
 *
 * Preview and Confirm live in separate modules, and deliberately so: a
 * financial mutation may not contain a second transaction boundary, and the
 * architectural test checks that per module (ADR 0010 §16 item 5).
 */
export * from './classify';
export * from './confirm';
export * from './derive';
export * from './draft';
export * from './fingerprint';
export * from './guard';
export * from './preview';
export * from './types';
