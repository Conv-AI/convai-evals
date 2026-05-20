import type { VisualPrompt } from "./visualTypes.js";

export const DEFAULT_VISUAL_PROMPTS: VisualPrompt[] = [
  { id: 1, text: "How are you doing today?" },
  { id: 2, text: "What is your favorite thing to talk about?" },
  { id: 3, text: "What should I try next?" },
  { id: 4, text: "Can you give me some encouragement?" },
  { id: 5, text: "What do blue moon and balloon have in common?" },
  { id: 6, text: "What makes a good adventure story?" },
  { id: 7, text: "How does a compass work?" },
  { id: 8, text: "What question would you ask me to get to know me better?" },
  { id: 9, text: "What words come to mind when you think of the ocean?" },
  { id: 10, text: "What is the most exciting thing about the future?" },
  { id: 11, text: "Can you count something interesting for me?" },
  { id: 12, text: "What is a story you would love to tell?" },
  { id: 13, text: "What is your opinion on peanut butter and jelly?" },
  { id: 14, text: "What does the word futuristic mean to you?" },
  { id: 15, text: "What is the best way to stay calm under pressure?" },
  { id: 16, text: "What would surprise you most right now?" },
  { id: 17, text: "What do purple, round, and spaceship have in common?" },
  { id: 18, text: "What is one safety tip everyone should know?" },
  { id: 19, text: "What are some words that begin with the letters M, B, or P?" },
  { id: 20, text: "How would you wrap up a great conversation?" },
];

export function parsePromptLines(raw: string): VisualPrompt[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((text, idx) => ({ id: idx + 1, text }));
}

export function promptsToText(prompts: readonly VisualPrompt[]): string {
  return prompts.map((p) => p.text).join("\n");
}
