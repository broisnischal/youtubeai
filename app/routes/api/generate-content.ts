import { json } from "@remix-run/node";
import type { ActionFunction } from "@remix-run/node";

export const action: ActionFunction = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { transcript } = await request.json();

  // TODO: Implement the actual LLM call here
  // For now, we'll return dummy data
  const dummyResponse = {
    title: "Generated Video Title",
    description:
      "This is a generated description based on the video transcript.",
  };

  return json(dummyResponse);
};
