import { describe, expect, it } from 'vitest';
import { kofiUrl } from '../src/server/support';

describe('Ko-fi deployment configuration', () => {
  it('accepts direct profile links and trims surrounding whitespace', () => {
    expect(kofiUrl(' https://ko-fi.com/developer_123/ ')).toBe('https://ko-fi.com/developer_123/');
  });

  it.each([
    '',
    '   ',
    'not a URL',
    'http://ko-fi.com/developer',
    'https://ko-fi.com/',
    'https://ko-fi.com.evil.test/developer',
    'https://ko-fi.com@evil.test/developer',
    'javascript:alert(1)',
    'https://ko-fi.com/developer?redirect=elsewhere',
    'https://ko-fi.com/developer/shop',
  ])('hides support for missing or invalid configuration: %s', (value) => {
    expect(kofiUrl(value)).toBeNull();
  });
});
