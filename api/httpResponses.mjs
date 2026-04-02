export async function readJsonFromResponse(response, fallbackMessage) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    if (text.trim().startsWith('<')) {
      throw new Error(`${fallbackMessage}: upstream returned HTML`);
    }

    throw new Error(fallbackMessage);
  }
}
