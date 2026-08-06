export function buildPrompt(profileLabel, title, url, text, intent="") {
  return `You are a helpful summariser. Summarise the following webpage content from the perspective of a ${profileLabel}, focusing on what's most relevant to that role or expertise.

Page Title: ${title}
Page URL: ${url}

Content:
${intent.trim() ? `\nThe reader has specified this intent for the summary — prioritize it above the general profile focus: ${intent.trim()}\n` : ''}
Please provide a concise, clear summary (2-3 paragraphs) highlighting the key points most relevant to a ${profileLabel}.
Directly output the summariser's response without saying that from the perspective of a ${profileLabel}.
${text}`;
}
