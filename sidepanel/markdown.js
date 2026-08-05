// Minimal Markdown renderer for model output.
//
// Model output is derived from arbitrary webpage content, so it is treated as
// untrusted: HTML is escaped BEFORE any tags are introduced, which means markup
// smuggled through the page (or a prompt injection) can never become live HTML.
// Only the tags generated below are ever real.

const CODE_PLACEHOLDER = '\u0000';

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Inline formatting, applied to already-escaped text.
function renderInline(text) {
  // Lift `code` spans out first and restore them at the end, so formatting
  // markers inside them stay literal (`**x**` must not become bold). The
  // delimiter is a null byte, which cannot appear in the model's text, so the
  // placeholder can never collide with real content.
  const codes = [];
  let out = text.replace(
    /`([^`]+)`/g,
    (_, code) => CODE_PLACEHOLDER + (codes.push(code) - 1) + CODE_PLACEHOLDER
  );

  out = out
    // Bold before italic: otherwise the single-asterisk rule eats **x**.
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|\s)_([^_]+)_/g, '$1<em>$2</em>');

  const placeholder = new RegExp(`${CODE_PLACEHOLDER}(\\d+)${CODE_PLACEHOLDER}`, 'g');
  return out.replace(placeholder, (_, index) => `<code>${codes[index]}</code>`);
}

function flushList(html, listType) {
  return listType ? html + `</${listType}>` : html;
}

export function renderMarkdown(markdown) {
  const lines = escapeHtml(markdown).split('\n');
  let html = '';
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${renderInline(paragraph.join(' '))}</p>`;
      paragraph = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      html = flushList(html, listType);
      listType = null;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed);

    if (heading) {
      flushParagraph();
      html = flushList(html, listType);
      listType = null;
      const level = Math.min(heading[1].length + 2, 6); // #  -> h3, keeps it panel-sized
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      continue;
    }

    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (listType !== wanted) {
        html = flushList(html, listType);
        html += `<${wanted}>`;
        listType = wanted;
      }
      html += `<li>${renderInline((bullet || numbered)[1])}</li>`;
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return flushList(html, listType);
}
