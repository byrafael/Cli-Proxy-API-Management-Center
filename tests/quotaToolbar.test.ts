import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
const styles = readFileSync('src/features/quota/QuotaPage.module.scss', 'utf8');

describe('quota toolbar presentation contracts', () => {
  test('uses a named, explicit clear action and restores input focus', () => {
    expect(source).toContain('type="search"');
    expect(source).toContain('ref={searchInputRef}');
    expect(source).toContain('{search && (');
    expect(source).toContain("aria-label={t('quota_management.search_clear')}");
    expect(source).toContain(
      "handleSearchChange('');\n                  searchInputRef.current?.focus();"
    );
    expect(source).toContain('<IconX size={14} aria-hidden="true" />');
    expect(styles).toMatch(/&::-webkit-search-cancel-button,[\s\S]*?appearance: none;/);
  });

  test('keeps search, attention filter, redaction and grouping in one wrapping toolbar', () => {
    const toolbarStart = source.indexOf('<div className={styles.toolbar}>');
    const searchStart = source.indexOf('<div className={styles.search}>');
    const redactStart = source.indexOf('className={styles.redact}');
    const groupStart = source.indexOf('<div className={styles.groupBy}>');
    expect(searchStart).toBeGreaterThan(toolbarStart);
    expect(redactStart).toBeGreaterThan(searchStart);
    expect(groupStart).toBeGreaterThan(redactStart);
    expect(styles).toMatch(/\.toolbar\s*\{[^}]*flex-wrap: wrap;/);
    expect(styles).toContain('&:focus-within');
    expect(styles).toContain('&:focus-visible');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('exposes the redaction and grouping state to assistive tech', () => {
    expect(source).toContain('aria-pressed={redact}');
    expect(source).toContain('aria-pressed={groupBy === option}');
  });
});
