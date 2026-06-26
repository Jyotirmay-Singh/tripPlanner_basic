import { parseAmount, isValidAmount, refundExceedsSpend } from '../signedAmount';

describe('parseAmount', () => {
  it('parses decimals and a leading minus', () => {
    expect(parseAmount('40.50')).toBe(40.5);
    expect(parseAmount('-12.25')).toBe(-12.25);
  });
  it('blank / lone minus / junk -> NaN', () => {
    expect(Number.isNaN(parseAmount(''))).toBe(true);
    expect(Number.isNaN(parseAmount('-'))).toBe(true);
    expect(Number.isNaN(parseAmount('abc'))).toBe(true);
  });
});

describe('isValidAmount', () => {
  it('accepts any finite non-zero number, positive or negative', () => {
    expect(isValidAmount(10)).toBe(true);
    expect(isValidAmount(-0.01)).toBe(true);
    expect(isValidAmount(-999.99)).toBe(true);
  });
  it('rejects zero, NaN and non-finite', () => {
    expect(isValidAmount(0)).toBe(false);
    expect(isValidAmount(NaN)).toBe(false);
    expect(isValidAmount(Infinity)).toBe(false);
    expect(isValidAmount(-Infinity)).toBe(false);
  });
});

describe('refundExceedsSpend', () => {
  it('true only when a negative magnitude exceeds the net spend so far', () => {
    expect(refundExceedsSpend(-250, 100)).toBe(true);
    expect(refundExceedsSpend(-50, 100)).toBe(false);
    expect(refundExceedsSpend(-100, 100)).toBe(false); // equal -> not exceeding
  });
  it('treats a negative net spend as zero (any refund exceeds it)', () => {
    expect(refundExceedsSpend(-1, -500)).toBe(true);
  });
  it('never warns for positive amounts (normal expenses)', () => {
    expect(refundExceedsSpend(500, 100)).toBe(false);
    expect(refundExceedsSpend(0, 100)).toBe(false);
  });
});
