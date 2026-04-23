import { describe, it, expect } from 'vitest';
import { parseGithubRepo } from '../../src/cli/update.js';

describe('parseGithubRepo', () => {
  it('parses https URL with .git suffix', () => {
    expect(
      parseGithubRepo({
        repository: { url: 'https://github.com/owner/repo.git' },
      }),
    ).toBe('owner/repo');
  });

  it('parses https URL without .git suffix', () => {
    expect(
      parseGithubRepo({
        repository: { url: 'https://github.com/owner/repo' },
      }),
    ).toBe('owner/repo');
  });

  it('parses git+https URL', () => {
    expect(
      parseGithubRepo({
        repository: { url: 'git+https://github.com/owner/repo.git' },
      }),
    ).toBe('owner/repo');
  });

  it('parses git@github.com SSH URL', () => {
    expect(
      parseGithubRepo({
        repository: { url: 'git@github.com:owner/repo.git' },
      }),
    ).toBe('owner/repo');
  });

  it('parses npm shorthand "owner/repo"', () => {
    expect(
      parseGithubRepo({
        repository: 'owner/repo',
      }),
    ).toBe('owner/repo');
  });

  it('parses a string-typed repository field', () => {
    expect(
      parseGithubRepo({
        repository: 'https://github.com/owner/repo.git',
      }),
    ).toBe('owner/repo');
  });

  it('handles dots/underscores/hyphens in the repo name', () => {
    expect(
      parseGithubRepo({
        repository: { url: 'https://github.com/ettisberger/andybioticlaw.git' },
      }),
    ).toBe('ettisberger/andybioticlaw');
  });

  it('throws when repository is missing', () => {
    expect(() => parseGithubRepo({})).toThrow(/repository\.url/);
  });

  it('throws when URL is unparseable', () => {
    expect(() =>
      parseGithubRepo({
        repository: { url: 'https://gitlab.com/owner/repo.git' },
      }),
    ).toThrow(/could not parse/);
  });
});
