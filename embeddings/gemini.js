const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';

export async function summarizeReadme(readmeText, apiKey) {
  if (typeof readmeText !== 'string' || !readmeText.trim()) {
    throw new Error('README content cannot be empty.');
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Enter a Gemini API key to use README summaries.');
  }

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey.trim(),
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: [
            'Summarize GitHub README content for semantic repository matching.',
            'Describe the project purpose, main capabilities, intended users, and notable technologies when stated.',
            'Preserve distinctive names and technical terms, omit badges and repetitive boilerplate, and do not infer facts.',
            'Return a concise standalone plain-text summary of at most 200 words.',
          ].join(' '),
        }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: readmeText }],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512,
        responseMimeType: 'text/plain',
      },
    }),
  });

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Gemini returned an unreadable response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message = data?.error?.message;
    const error = new Error(
      typeof message === 'string' && message
        ? `Gemini could not summarize this README: ${message}`
        : `Gemini could not summarize this README (HTTP ${response.status}).`
    );
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }

  const summary = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text)
    .filter((text) => typeof text === 'string')
    .join('\n')
    .trim();
  if (!summary) {
    const reason =
      data?.promptFeedback?.blockReason ??
      data?.candidates?.[0]?.finishReason;
    const error = new Error(
      reason
        ? `Gemini did not return a README summary (${reason}).`
        : 'Gemini did not return a README summary. Check the README and try again.'
    );
    error.code = 'EMPTY_SUMMARY';
    throw error;
  }

  return summary;
}
