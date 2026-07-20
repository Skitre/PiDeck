import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  carryImagesAcrossEdit,
  pruneQueuedImages,
  recordQueuedImages,
  takeQueuedImages,
} from "./queue-attachments.js";

function fakeSession(): AgentSession {
  return {} as AgentSession;
}

function image(name: string): ImageContent[] {
  return [{ type: "image", mimeType: "image/png", data: name }];
}

describe("queue-attachments", () => {
  it("records and takes per text, popping duplicates in insertion order", () => {
    const session = fakeSession();
    recordQueuedImages(session, "same", image("first"));
    recordQueuedImages(session, "same", image("second"));

    expect(takeQueuedImages(session, "same")).toEqual(image("first"));
    expect(takeQueuedImages(session, "same")).toEqual(image("second"));
    expect(takeQueuedImages(session, "same")).toBeUndefined();
  });

  it("keeps sessions isolated", () => {
    const a = fakeSession();
    const b = fakeSession();
    recordQueuedImages(a, "text", image("a"));
    expect(takeQueuedImages(b, "text")).toBeUndefined();
    expect(takeQueuedImages(a, "text")).toEqual(image("a"));
  });

  it("prunes entries not present in the live queue multiset", () => {
    const session = fakeSession();
    recordQueuedImages(session, "kept", image("kept"));
    recordQueuedImages(session, "delivered", image("gone"));
    recordQueuedImages(session, "dup", image("dup-1"));
    recordQueuedImages(session, "dup", image("dup-2"));

    pruneQueuedImages(session, ["kept", "dup"]);

    expect(takeQueuedImages(session, "delivered")).toBeUndefined();
    expect(takeQueuedImages(session, "kept")).toEqual(image("kept"));
    expect(takeQueuedImages(session, "dup")).toEqual(image("dup-1"));
    expect(takeQueuedImages(session, "dup")).toBeUndefined();
  });

  it("carries images across a single edit", () => {
    const session = fakeSession();
    recordQueuedImages(session, "original text", image("pic"));

    carryImagesAcrossEdit(
      session,
      ["plain", "original text"],
      ["plain", "edited text"],
    );

    expect(takeQueuedImages(session, "original text")).toBeUndefined();
    expect(takeQueuedImages(session, "edited text")).toEqual(image("pic"));
  });

  it("does not guess when the rebuild is ambiguous", () => {
    const session = fakeSession();
    recordQueuedImages(session, "a", image("a"));
    recordQueuedImages(session, "b", image("b"));

    // Two imaged texts removed, two unknown texts added — no safe mapping.
    carryImagesAcrossEdit(session, ["a", "b"], ["x", "y"]);

    expect(takeQueuedImages(session, "x")).toBeUndefined();
    expect(takeQueuedImages(session, "y")).toBeUndefined();
    expect(takeQueuedImages(session, "a")).toEqual(image("a"));
    expect(takeQueuedImages(session, "b")).toEqual(image("b"));
  });

  it("plain delete of an imaged item is not treated as an edit", () => {
    const session = fakeSession();
    recordQueuedImages(session, "deleted", image("bye"));

    // One imaged text removed but nothing unknown appeared — pure delete.
    carryImagesAcrossEdit(session, ["deleted", "stays"], ["stays"]);

    expect(takeQueuedImages(session, "stays")).toBeUndefined();
    expect(takeQueuedImages(session, "deleted")).toEqual(image("bye"));
  });
});
