export function buildPrompt(profileLabel, title, url, text) {
  return `You are a helpful summariser. Summarise the following webpage content from the perspective of a ${profileLabel}, focusing on what's most relevant to that role or expertise.

Page Title: ${title}
Page URL: ${url}

Content:
${text}

Please provide a concise, clear summary (2-3 paragraphs) highlighting the key points most relevant to a ${profileLabel}.`;
}
