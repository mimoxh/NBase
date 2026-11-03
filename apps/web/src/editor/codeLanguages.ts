/** Values are Prism grammar ids; unknown stored languages render as plain text. */
export const CODE_LANGUAGES: [string, string][] = [
  ['plain', '纯文本'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['markup', 'HTML/XML'],
  ['css', 'CSS'],
  ['markdown', 'Markdown'],
  ['python', 'Python'],
  ['java', 'Java'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['rust', 'Rust'],
  ['swift', 'Swift'],
  ['objectivec', 'Objective-C'],
  ['sql', 'SQL'],
  ['powershell', 'PowerShell'],
  ['bash', 'Bash/Shell'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['go', 'Go'],
];

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  sh: 'bash', shell: 'bash', zsh: 'bash',
  yml: 'yaml', py: 'python',
  html: 'markup', xml: 'markup', svg: 'markup',
  'c++': 'cpp', golang: 'go', ps1: 'powershell',
  md: 'markdown', objc: 'objectivec',
};

/** Map common Markdown info-string aliases to selector values; unknown names are preserved verbatim. */
export function normalizeCodeBlockLanguage(language: string | undefined): string | undefined {
  if (!language) return language;
  return CODE_LANGUAGE_ALIASES[language.trim().toLowerCase()] ?? language;
}
