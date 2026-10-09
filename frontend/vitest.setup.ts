import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Required because vitest.config.mts runs with globals: false (explicit
// describe/it/expect imports in every test file, matching this repo's
// own convention elsewhere) — @testing-library/react's own auto-cleanup
// only self-registers when it finds vitest's globals, so without this
// every render() in a file would stack up in the DOM across tests
// instead of being unmounted between them.
afterEach(() => {
  cleanup();
});
