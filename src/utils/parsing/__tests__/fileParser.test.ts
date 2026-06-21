import { isValidFileType, parseFile } from '../fileParser';

describe('isValidFileType', () => {
  it('accepts every supported extension', () => {
    ['txt', 'pdf', 'docx', 'json', 'md', 'markdown', 'yaml', 'yml'].forEach((ext) =>
      expect(isValidFileType(`doc.${ext}`)).toBe(true),
    );
  });

  it('is case-insensitive on the extension', () => {
    expect(isValidFileType('Report.PDF')).toBe(true);
    expect(isValidFileType('Spec.YAML')).toBe(true);
  });

  it('rejects unsupported extensions', () => {
    expect(isValidFileType('malware.exe')).toBe(false);
    expect(isValidFileType('image.png')).toBe(false);
    expect(isValidFileType('archive.tar.gz')).toBe(false);
  });

  it('rejects a name with no extension', () => {
    expect(isValidFileType('README')).toBe(false);
  });

  it('uses the final extension of a multi-dot name', () => {
    expect(isValidFileType('api.spec.json')).toBe(true);
  });
});

describe('parseFile input validation', () => {
  it('rejects an empty or non-string filePath before touching the filesystem', async () => {
    await expect(parseFile('', 'a.txt')).rejects.toThrow('Invalid filePath');
    await expect(parseFile(null as any, 'a.txt')).rejects.toThrow('Invalid filePath');
  });

  it('rejects an empty or non-string originalName', async () => {
    await expect(parseFile('/tmp/x', '')).rejects.toThrow('Invalid originalName');
    await expect(parseFile('/tmp/x', null as any)).rejects.toThrow('Invalid originalName');
  });
});
