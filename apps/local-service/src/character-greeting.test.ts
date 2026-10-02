import { afterEach, expect, it } from "vitest";
import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function fixture(first = "Original") {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: "Greeting", first_mes: first } })).body;
  const card = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: card.id } })).json();
  return { app, avatar, card, story, preview: async () => (await app.inject({ method: "GET", url: `/api/conversations/${story.id}/greeting` })).json() };
}

it("previews output-regex greetings and swipe metadata without changing chat or expanding source macros", async () => {
  const { app, avatar, card, story, preview } = await fixture();
  const edited = await app.inject({ method: "POST", url: "/api/characters/edit", payload: { avatar_url: avatar,
    first_mes: "Hello {{user}}", alternate_greetings: ["Hello {{char}}", "Other"],
    extensions: { regex_scripts: [{ scriptName: "Greeting output", findRegex: "Hello", replaceString: "Welcome", placement: [2], disabled: false }] },
  } });
  expect(edited.statusCode, edited.body).toBe(200);
  expect((await app.inject({ method: "PUT", url: `/api/characters/${card.id}/regex/all`, payload: { enabled: true } })).statusCode).toBe(200);
  const result = await preview();
  expect(result).toMatchObject({ characterId: card.id, branchId: story.activeBranchId, tainted: false,
    message: { name: "Greeting", mes: "Welcome {{user}}", is_user: false, is_system: false, swipe_id: 0,
      swipes: ["Welcome {{user}}", "Welcome {{char}}", "Other"], extra: {} } });
  expect(result.message.swipe_info).toEqual(result.message.swipes.map(() => ({ send_date: result.message.send_date, extra: {} })));
  const unchanged = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  expect(unchanged.messages).toEqual(story.messages);
  expect((await app.inject({ method: "GET", url: "/api/conversations/missing/greeting" })).statusCode).toBe(404);
});

it("uses the first alternate when the main greeting is empty and reports native edits/deletion as tainted", async () => {
  const { app, avatar, story, preview } = await fixture();
  await app.inject({ method: "POST", url: "/api/characters/edit", payload: { avatar_url: avatar, first_mes: "", alternate_greetings: ["Alternate", "Last"] } });
  expect((await preview()).message).toMatchObject({ mes: "Alternate", swipes: ["Alternate", "Last"] });
  await app.inject({ method: "PATCH", url: `/api/conversations/${story.id}/messages/${story.messages[0].id}`, payload: { content: "User edited greeting" } });
  expect((await preview()).tainted).toBe(true);
  await app.inject({ method: "DELETE", url: `/api/conversations/${story.id}/messages/${story.messages[0].id}` });
  expect((await preview()).tainted).toBe(true);
  await app.inject({ method: "POST", url: "/api/characters/edit", payload: { avatar_url: avatar, first_mes: "" } });
  const empty = (await preview()).message;
  expect(empty.mes).toBe(""); expect(empty.swipes).toBeUndefined();
});
