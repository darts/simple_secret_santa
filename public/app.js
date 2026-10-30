"use strict";

(() => {
  const elements = Object.fromEntries([
    "participant-grid", "loading-state", "opened-count", "count-text", "notice",
    "retry-button", "participants", "confirm-dialog", "confirm-name", "confirm-button",
    "confirm-button-text", "cancel-button", "request-status", "reveal-dialog",
    "recipient-name", "close-reveal-button", "motion-toggle",
  ].map((id) => [id, document.getElementById(id)]));

  let participants = [];
  let selection = null;
  let pending = false;
  let refreshing = false;
  let hasLoaded = false;
  let lastListSignature = "";
  let pageCycle = 0;
  let drawGeneration = 0;
  let revealController = null;
  let refreshController = null;
  let refreshAgain = false;
  let focusReturnId = null;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let motionManuallyChosen = false;
  let motionPaused = reducedMotion.matches;

  function applyMotionPreference() {
    document.documentElement.classList.toggle("motion-paused", motionPaused);
    document.documentElement.classList.toggle("motion-opt-in", motionManuallyChosen && !motionPaused);
    elements["motion-toggle"].setAttribute("aria-pressed", String(motionPaused));
    const action = motionPaused ? "Resume animations" : "Pause animations";
    elements["motion-toggle"].setAttribute("aria-label", action);
    elements["motion-toggle"].title = action;
    elements["motion-toggle"].querySelector(".motion-label").textContent = motionPaused ? "Resume the magic" : "Pause the magic";
  }

  elements["motion-toggle"].addEventListener("click", () => {
    motionManuallyChosen = true;
    motionPaused = !motionPaused;
    applyMotionPreference();
  });
  reducedMotion.addEventListener("change", () => {
    if (!motionManuallyChosen) {
      motionPaused = reducedMotion.matches;
      applyMotionPreference();
    }
  });
  applyMotionPreference();

  function showNotice(message) {
    elements.notice.textContent = message;
    elements.notice.hidden = false;
  }

  function clearNotice() {
    elements.notice.textContent = "";
    elements.notice.hidden = true;
  }

  function updateCount() {
    const opened = participants.filter((person) => person.revealed).length;
    elements["count-text"].textContent = `${String(opened).padStart(2, "0")} / ${String(participants.length).padStart(2, "0")} OPENED`;
    elements["opened-count"].setAttribute("aria-label", `${opened} of ${participants.length} envelopes opened`);
  }

  function makeCard(person) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "participant-card";
    card.dataset.participantId = person.id;

    const initial = document.createElement("span");
    initial.className = "participant-initial";
    initial.setAttribute("aria-hidden", "true");
    initial.textContent = Array.from(person.name)[0]?.toLocaleUpperCase() || "✦";

    const info = document.createElement("span");
    info.className = "participant-info";
    const name = document.createElement("span");
    name.className = "participant-name";
    name.textContent = person.name;
    const status = document.createElement("span");
    status.className = "participant-state";
    info.append(name, status);

    const arrow = document.createElement("span");
    arrow.className = "participant-arrow";
    arrow.setAttribute("aria-hidden", "true");
    card.append(initial, info, arrow);
    card.addEventListener("click", () => openConfirmation(person.id));
    return card;
  }

  function renderParticipants() {
    const signature = JSON.stringify(participants);
    if (signature === lastListSignature) return;
    lastListSignature = signature;

    const existing = new Map(Array.from(elements["participant-grid"].children, (card) => [card.dataset.participantId, card]));
    for (const person of participants) {
      const card = existing.get(person.id) || makeCard(person);
      const wasFocused = document.activeElement === card;
      card.disabled = person.revealed;
      card.classList.toggle("is-revealed", person.revealed);
      card.setAttribute("aria-label", `${person.name}, ${person.revealed ? "already opened" : "open your envelope"}`);
      card.querySelector(".participant-name").textContent = person.name;
      card.querySelector(".participant-state").textContent = person.revealed ? "ALREADY OPENED" : "YOURS TO OPEN";
      card.querySelector(".participant-arrow").textContent = person.revealed ? "✓" : "↗";
      if (!existing.has(person.id)) elements["participant-grid"].append(card);
      existing.delete(person.id);
      if (wasFocused && person.revealed && !elements["confirm-dialog"].open && !elements["reveal-dialog"].open) {
        elements.participants.focus({ preventScroll: true });
      }
    }
    for (const card of existing.values()) card.remove();
    updateCount();
  }

  async function refreshParticipants({ explicit = false } = {}) {
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    if (document.hidden) return;
    refreshing = true;
    const cycle = pageCycle;
    const controller = new AbortController();
    refreshController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/api/participants", { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error("list-unavailable");
      const result = await response.json();
      if (!Array.isArray(result.participants) || !result.participants.every((person) => typeof person.id === "string" && typeof person.name === "string" && typeof person.revealed === "boolean")) {
        throw new Error("invalid-list");
      }
      if (cycle !== pageCycle) return;
      const previousIds = new Set(participants.map((person) => person.id));
      const drawChanged = hasLoaded && previousIds.size > 0 && result.participants.length > 0
        && result.participants.every((person) => !previousIds.has(person.id));
      if (drawChanged) resetDrawUi();
      // A list request started before a successful reveal must never re-enable it.
      const consumed = new Set(participants.filter((person) => person.revealed).map((person) => person.id));
      participants = result.participants.map((person) => ({ ...person, revealed: person.revealed || consumed.has(person.id) }));
      hasLoaded = true;
      renderParticipants();
      elements["loading-state"].hidden = true;
      elements["retry-button"].hidden = true;
      if (explicit || elements.notice.dataset.kind === "availability") {
        clearNotice();
        delete elements.notice.dataset.kind;
      }
      if (participants.length === 0) showNotice("The list is empty. Your organizer is still gathering the usual suspects.");
      if (drawChanged) {
        elements.notice.dataset.kind = "draw-reset";
        showNotice("The participant list changed. A new draw is ready.");
      }
    } catch {
      if (cycle !== pageCycle) return;
      elements["loading-state"].hidden = true;
      elements["retry-button"].hidden = false;
      if (elements.notice.hidden || elements.notice.dataset.kind === "availability") {
        elements.notice.dataset.kind = "availability";
        showNotice(hasLoaded ? "The list couldn’t refresh. Availability may have changed; we’ll check again shortly." : "The list is keeping its distance. We couldn’t reach the server—please try again in a moment.");
      }
      if (!hasLoaded) elements["count-text"].textContent = "THE LIST IS UNAVAILABLE";
    } finally {
      window.clearTimeout(timeout);
      if (refreshController === controller) refreshController = null;
      refreshing = false;
      if (refreshAgain) {
        refreshAgain = false;
        void refreshParticipants();
      }
    }
  }

  function restoreFocus() {
    const card = Array.from(elements["participant-grid"].children).find((item) => item.dataset.participantId === focusReturnId);
    if (card && !card.disabled) card.focus({ preventScroll: true });
    else elements.participants.focus({ preventScroll: true });
  }

  function syncDialogBody() {
    document.body.classList.toggle("dialog-open", elements["confirm-dialog"].open || elements["reveal-dialog"].open);
  }

  function resetDrawUi() {
    // Abort is best effort: the generation also rejects an already-delivered response.
    drawGeneration += 1;
    const staleController = revealController;
    revealController = null;
    staleController?.abort();
    pending = false;
    selection = null;
    focusReturnId = null;
    clearRecipient();
    elements["confirm-name"].textContent = "";
    elements["confirm-button"].disabled = false;
    elements["cancel-button"].disabled = false;
    elements["confirm-button-text"].textContent = "Open my envelope";
    elements["request-status"].textContent = "";
    if (elements["confirm-dialog"].open) elements["confirm-dialog"].close();
    if (elements["reveal-dialog"].open) elements["reveal-dialog"].close();
    syncDialogBody();
  }

  function openConfirmation(id) {
    const person = participants.find((item) => item.id === id);
    if (!person || person.revealed || pending || elements["reveal-dialog"].open) return;
    clearNotice();
    delete elements.notice.dataset.kind;
    selection = person;
    focusReturnId = id;
    elements["confirm-name"].textContent = person.name;
    elements["confirm-button"].disabled = false;
    elements["cancel-button"].disabled = false;
    elements["confirm-button-text"].textContent = "Open my envelope";
    elements["request-status"].textContent = "";
    elements["confirm-dialog"].showModal();
    syncDialogBody();
  }

  function closeConfirmation() {
    if (pending) return;
    elements["confirm-dialog"].close();
  }

  elements["cancel-button"].addEventListener("click", closeConfirmation);
  elements["confirm-dialog"].addEventListener("cancel", (event) => {
    if (pending) event.preventDefault();
  });
  elements["confirm-dialog"].addEventListener("close", () => {
    // A queued close event can arrive after this dialog has opened for the new draw.
    if (elements["confirm-dialog"].open) return;
    selection = null;
    elements["confirm-name"].textContent = "";
    syncDialogBody();
    if (!elements["reveal-dialog"].open) restoreFocus();
  });
  elements["confirm-dialog"].addEventListener("click", (event) => {
    if (event.target !== elements["confirm-dialog"]) return;
    const bounds = elements["confirm-dialog"].getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeConfirmation();
  });

  elements["confirm-button"].addEventListener("click", async () => {
    if (pending || !selection) return;
    const person = selection;
    const cycle = pageCycle;
    const generation = drawGeneration;
    pending = true;
    elements["confirm-button"].disabled = true;
    elements["cancel-button"].disabled = true;
    elements["confirm-button-text"].textContent = "Opening your envelope…";
    elements["request-status"].textContent = "Opening your envelope. Please wait.";
    const controller = new AbortController();
    revealController = controller;
    const isCurrentRequest = () => cycle === pageCycle && generation === drawGeneration && revealController === controller;
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    let failureMessage = "The connection was interrupted. Your envelope may already have been opened. Check with the organizer if the name didn’t appear; this request won’t be retried automatically.";

    try {
      const response = await fetch(`/api/reveal/${encodeURIComponent(person.id)}`, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: controller.signal });
      if (!isCurrentRequest()) return;
      if (response.status === 409) {
        const current = participants.find((item) => item.id === person.id);
        if (current) current.revealed = true;
        failureMessage = "That envelope has already been opened. Its secret can’t be shown again. If it wasn’t you, contact your organizer.";
        throw new Error("already-opened");
      }
      if (response.status === 404) {
        failureMessage = "That name is no longer in the current draw. Refreshing the participant list…";
        throw new Error("not-found");
      }
      if (!response.ok) {
        failureMessage = "The server couldn’t complete your reveal. Please contact your organizer before trying again.";
        throw new Error("reveal-unavailable");
      }
      const result = await response.json();
      if (typeof result.recipient !== "string" || result.recipient.length === 0) throw new Error("invalid-reveal");
      if (!isCurrentRequest()) return;

      const current = participants.find((item) => item.id === person.id);
      if (current) current.revealed = true;
      renderParticipants();
      // The recipient is visible immediately; animation completion is never required.
      elements["recipient-name"].textContent = result.recipient;
      pending = false;
      elements["confirm-dialog"].close();
      elements["reveal-dialog"].showModal();
      syncDialogBody();
    } catch {
      if (!isCurrentRequest()) return;
      pending = false;
      elements["confirm-dialog"].close();
      renderParticipants();
      delete elements.notice.dataset.kind;
      showNotice(failureMessage);
    } finally {
      window.clearTimeout(timeout);
      const currentRequest = isCurrentRequest();
      if (revealController === controller) revealController = null;
      if (currentRequest) {
        pending = false;
        elements["confirm-button"].disabled = false;
        elements["cancel-button"].disabled = false;
        elements["request-status"].textContent = "";
        void refreshParticipants();
      }
    }
  });

  function clearRecipient() {
    elements["recipient-name"].textContent = "";
  }

  elements["close-reveal-button"].addEventListener("click", () => {
    clearRecipient();
    elements["reveal-dialog"].close();
  });
  elements["reveal-dialog"].addEventListener("cancel", clearRecipient);
  elements["reveal-dialog"].addEventListener("close", () => {
    if (elements["reveal-dialog"].open) return;
    clearRecipient();
    syncDialogBody();
    if (!elements["confirm-dialog"].open) restoreFocus();
  });

  elements["retry-button"].addEventListener("click", () => void refreshParticipants({ explicit: true }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshParticipants();
  });
  window.addEventListener("focus", () => void refreshParticipants());
  window.addEventListener("pagehide", () => {
    pageCycle += 1;
    revealController?.abort();
    refreshController?.abort();
    pending = false;
    selection = null;
    clearRecipient();
    elements["confirm-name"].textContent = "";
    if (elements["confirm-dialog"].open) elements["confirm-dialog"].close();
    if (elements["reveal-dialog"].open) elements["reveal-dialog"].close();
    syncDialogBody();
  });
  window.addEventListener("pageshow", () => void refreshParticipants());
  window.setInterval(() => void refreshParticipants(), 5000);
  void refreshParticipants();
})();
