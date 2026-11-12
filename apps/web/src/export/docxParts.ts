/** Static OOXML parts. Element order inside each *Pr follows the schema: Word rejects files that reorder them. */
export const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const REL_TYPES = {
  officeDocument: `${REL}/officeDocument`, styles: `${REL}/styles`, numbering: `${REL}/numbering`, footnotes: `${REL}/footnotes`,
  settings: `${REL}/settings`, image: `${REL}/image`, hyperlink: `${REL}/hyperlink`,
  core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
} as const;
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const WML = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

export const MEDIA_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function contentTypesXml(extensions: Set<string>): string {
  const media = [...extensions].sort().map(ext => `<Default Extension="${ext}" ContentType="image/${ext}"/>`).join('');
  return XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + `<Default Extension="xml" ContentType="application/xml"/>${media}`
    + `<Override PartName="/word/document.xml" ContentType="${WML}.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="${WML}.styles+xml"/>`
    + `<Override PartName="/word/numbering.xml" ContentType="${WML}.numbering+xml"/>`
    + `<Override PartName="/word/footnotes.xml" ContentType="${WML}.footnotes+xml"/>`
    + `<Override PartName="/word/settings.xml" ContentType="${WML}.settings+xml"/>`
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '</Types>';
}

export function relationshipsXml(items: { id: string; type: string; target: string; external?: boolean }[]): string {
  return XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(item => `<Relationship Id="${item.id}" Type="${item.type}" Target="${xmlAttr(item.target)}"${item.external ? ' TargetMode="External"' : ''}/>`).join('')
    + '</Relationships>';
}

export const packageRelsXml = () => relationshipsXml([
  { id: 'rId1', type: REL_TYPES.officeDocument, target: 'word/document.xml' },
  { id: 'rId2', type: REL_TYPES.core, target: 'docProps/core.xml' },
]);

export const coreXml = (title: string) => XML
  + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  + `<dc:title>${xmlText(title)}</dc:title><dc:creator>NBase</dc:creator>`
  + `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>`
  + '</cp:coreProperties>';

export const settingsXml = () => XML
  + `<w:settings xmlns:w="${NS_W}"><w:defaultTabStop w:val="420"/><w:characterSpacingControl w:val="compressPunctuation"/>`
  + '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>'
  + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
  + '<w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/></w:settings>';

// Latin text in Calibri/Consolas, CJK in Microsoft YaHei; WPS and LibreOffice substitute when a font is missing.
const fonts = (latin: string) => `<w:rFonts w:ascii="${latin}" w:hAnsi="${latin}" w:eastAsia="Microsoft YaHei" w:cs="${latin}"/>`;
const heading = (level: number, size: number) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>`
  + `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/>`
  + `<w:spacing w:before="${level < 3 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>`
  + `<w:rPr><w:b/><w:bCs/>${level === 6 ? '<w:color w:val="595959"/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

export const stylesXml = () => XML
  + `<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr>${fonts('Calibri')}<w:sz w:val="22"/><w:szCs w:val="22"/>`
  + '<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>'
  + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
  + '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>'
  + heading(1, 36) + heading(2, 30) + heading(3, 26) + heading(4, 24) + heading(5, 22) + heading(6, 22)
  + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>'
  + '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D3CC"/></w:pBdr><w:ind w:left="240"/></w:pPr><w:rPr><w:color w:val="5F6368"/></w:rPr></w:style>'
  + `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr>`
  + '<w:top w:val="single" w:sz="4" w:space="4" w:color="E1E3DD"/><w:left w:val="single" w:sz="4" w:space="4" w:color="E1E3DD"/>'
  + '<w:bottom w:val="single" w:sz="4" w:space="4" w:color="E1E3DD"/><w:right w:val="single" w:sz="4" w:space="4" w:color="E1E3DD"/></w:pBdr>'
  + `<w:shd w:val="clear" w:color="auto" w:fill="F4F4F1"/><w:spacing w:before="120" w:after="120" w:line="276" w:lineRule="auto"/><w:ind w:left="96" w:right="96"/></w:pPr>`
  + `<w:rPr>${fonts('Consolas')}<w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>`
  + `<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr>${fonts('Consolas')}`
  + '<w:color w:val="B3452F"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F1F1EE"/></w:rPr></w:style>'
  + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>'
  + '<w:rPr><w:color w:val="2F6F9F"/><w:u w:val="single"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="6F7470"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>'
  + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>'
  + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>'
  + '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>'
  + '<w:pPr><w:spacing w:after="60"/></w:pPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>'
  + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>'
  + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D5D7D0"/>`).join('')
  + '</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + '</w:styles>';

export const LIST_INDENT = 420;
const bullets = ['•', '◦', '▪'];
const orderedFormats = ['decimal', 'lowerLetter', 'lowerRoman'];
const level = (ilvl: number, format: string, text: string, font = '') => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>`
  + `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${LIST_INDENT * (ilvl + 1)}" w:hanging="${LIST_INDENT}"/></w:pPr>${font}</w:lvl>`;
export const BULLET_ABSTRACT = 0, ORDERED_ABSTRACT = 1, BULLET_NUM = 1;

/** One shared bullet instance; every ordered list gets its own instance whose start override restarts it. */
export function numberingXml(ordered: { numId: number; ilvl: number; start: number }[]): string {
  const levels = Array.from({ length: 9 }, (_, ilvl) => ilvl);
  return XML + `<w:numbering xmlns:w="${NS_W}">`
    + `<w:abstractNum w:abstractNumId="${BULLET_ABSTRACT}"><w:multiLevelType w:val="hybridMultilevel"/>`
    + levels.map(ilvl => level(ilvl, 'bullet', bullets[ilvl % 3]!, '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr>')).join('') + '</w:abstractNum>'
    + `<w:abstractNum w:abstractNumId="${ORDERED_ABSTRACT}"><w:multiLevelType w:val="hybridMultilevel"/>`
    + levels.map(ilvl => level(ilvl, orderedFormats[ilvl % 3]!, `%${ilvl + 1}.`)).join('') + '</w:abstractNum>'
    + `<w:num w:numId="${BULLET_NUM}"><w:abstractNumId w:val="${BULLET_ABSTRACT}"/></w:num>`
    + ordered.map(item => `<w:num w:numId="${item.numId}"><w:abstractNumId w:val="${ORDERED_ABSTRACT}"/>`
      + `<w:lvlOverride w:ilvl="${item.ilvl}"><w:startOverride w:val="${item.start}"/></w:lvlOverride></w:num>`).join('')
    + '</w:numbering>';
}

export const footnotesXml = (notes: string[]) => XML
  + `<w:footnotes xmlns:w="${NS_W}" xmlns:r="${NS_R}" ${DRAWING_NS}>`
  + '<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>'
  + '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
  + notes.join('') + '</w:footnotes>';

export const DRAWING_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/** A4 with 2.54 cm margins. */
export const PAGE = { width: 11906, height: 16838, margin: 1440 } as const;
export const CONTENT_TWIPS = PAGE.width - PAGE.margin * 2;
export const sectionXml = () => `<w:sectPr><w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"/>`
  + `<w:pgMar w:top="${PAGE.margin}" w:right="${PAGE.margin}" w:bottom="${PAGE.margin}" w:left="${PAGE.margin}" w:header="851" w:footer="992" w:gutter="0"/>`
  + '<w:cols w:space="425"/></w:sectPr>';

export const documentXml = (body: string) => XML
  + `<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" ${DRAWING_NS}><w:body>${body}${sectionXml()}</w:body></w:document>`;

// XML 1.0 forbids most control characters and lone surrogates; Word refuses the whole file on one of them.
const invalidXml = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const xmlText = (text: string) => text.replace(invalidXml, '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);
export const xmlAttr = (text: string) => xmlText(text).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
