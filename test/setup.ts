import { afterAll } from "vitest";
import { cleanupTmp } from "./helpers.js";

afterAll(() => cleanupTmp());
