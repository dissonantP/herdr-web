import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@herdr/server/chat.ts";
import { imagePaths, isImageName, slashMatches, withoutPath, withPath } from "./chat-input.ts";

const cmd = (name: string): SlashCommand => ({ name, description: "", arg: "" });
const all = ["/compact", "/clear", "/model", "/memory", "/git:sync", "/context"].map(cmd);
const names = (text: string) => slashMatches(text, all).map((c) => c.name);

describe("slashMatches", () => {
  it("offers commands while a bare /word is typed: prefix first, then those with a later part starting with it", () => {
    expect(names("/")).toHaveLength(6);
    expect(names("/c")).toEqual(["/compact", "/clear", "/context"]);
    expect(names("/m")).toEqual(["/model", "/memory"]);
    expect(names("/sync")).toEqual(["/git:sync"]);
  });
  it("stops once the command is typed out, or anything follows it", () => {
    expect(names("/clear")).toEqual([]);
    expect(names("/compact keep the tests")).toEqual([]);
    expect(names("hello /c")).toEqual([]);
  });
});

describe("withPath", () => {
  it("adds an uploaded file's path after the text, spaced", () => {
    expect(withPath("", "/f/a.png")).toBe("/f/a.png ");
    expect(withPath("look at", "/f/a.png")).toBe("look at /f/a.png ");
    expect(withPath("look at ", "/f/a.png")).toBe("look at /f/a.png ");
  });
});

describe("image previews", () => {
  it("finds image paths in a sent message, once each, and ignores other files", () => {
    expect(imagePaths("look /s/files/t1/a.png and /s/files/t1/b.JPG /s/files/t1/a.png /s/files/t1/doc.pdf")).toEqual(["/s/files/t1/a.png", "/s/files/t1/b.JPG"]);
    expect(imagePaths("no paths here, not/absolute.png")).toEqual([]);
  });
  it("tells image names from the rest", () => {
    expect(isImageName("shot.PNG")).toBe(true);
    expect(isImageName("notes.svg")).toBe(false);
  });
  it("removes an uploaded path and its trailing space from the text", () => {
    expect(withoutPath("see /f/a.png now", "/f/a.png")).toBe("see now");
    expect(withoutPath("/f/a.png ", "/f/a.png")).toBe("");
    expect(withoutPath("nothing", "/f/a.png")).toBe("nothing");
  });
});
