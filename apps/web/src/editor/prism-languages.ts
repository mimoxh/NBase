// The prismjs main module installs the shared `Prism` global that
// @lexical/code-prism tokenizes with; component imports extend the same
// instance, so order matters: prismjs first, extra grammars after.
// code-prism itself already loads javascript, typescript, markup, css, c, cpp,
// go, java, markdown, objectivec, powershell, python, rust, sql and swift.
// This file must stay out of non-DOM code paths: in Node `prismjs` has no
// window to attach the global to and component imports would fail.
import 'prismjs';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
