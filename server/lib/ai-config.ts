/** The assistant is available when Anthropic credentials are present in the environment. */
export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
export const aiConfigured = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
