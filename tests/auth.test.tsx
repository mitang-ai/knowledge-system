// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Login } from "../src/views/Auth";
import { credentialsText, generateCredentials } from "../src/auth/credentials";
import { api } from "../src/lib";

vi.mock("../src/lib", () => ({ api: vi.fn() }));
let container: HTMLDivElement, root: Root;
const onSuccess = vi.fn(async () => {});
const button = (text: string) => Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes(text))!;
const click = async (node: HTMLElement) => { await act(async () => { node.click(); }); };
const render = async (register = false) => { await act(async () => { root.render(<Login key={String(register)} onSuccess={onSuccess} initialRegister={register} />); }); };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(api).mockReset().mockResolvedValue({ ok: true }); onSuccess.mockClear();
  localStorage.clear(); sessionStorage.clear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("one-click account creation", () => {
  it("offers the same quick entry and visible safekeeping warning on login and registration", async () => {
    await render(); expect(button("一键创建账号密码")).toBeTruthy(); expect(container.textContent).toContain("丢失账密可能无法找回");
    await render(true); expect(button("一键创建账号密码")).toBeTruthy(); expect(container.querySelector('input[autocomplete="nickname"]')).toBeTruthy();
  });
  it("creates once, displays credentials, and requires explicit saved acknowledgement before entering", async () => {
    await render(); await click(button("一键创建账号密码"));
    expect(api).toHaveBeenCalledTimes(1); const [path, body] = vi.mocked(api).mock.calls[0];
    expect(path).toBe("register"); expect(body).toMatchObject({ display_name: "新的思考者" });
    const credentials = body as { email: string; password: string };
    expect(credentials.email).toMatch(/^sd_[a-f0-9]{24}@account\.invalid$/);
    expect(credentials.password).toMatch(/^Sd![a-f0-9]{32}$/);
    const fields = container.querySelectorAll<HTMLInputElement>("input[readonly]");
    expect(fields[0].value).toBe(credentials.email); expect(fields[1].value).toBe(credentials.password);
    expect(button("进入我的知识空间").disabled).toBe(true); expect(onSuccess).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(credentials.password);
    await click(container.querySelector('input[type="checkbox"]')!); await click(button("进入我的知识空间"));
    expect(onSuccess).toHaveBeenCalledTimes(1); expect(api).toHaveBeenCalledTimes(1);
  });
  it("blocks duplicate clicks while registration is in flight", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render(); const entry = button("一键创建账号密码");
    await act(async () => { entry.click(); entry.click(); }); expect(api).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ok: true }); });
  });
  it("preserves the same credentials after an uncertain network response and offers login recovery", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("网络中断")); await render(); await click(button("一键创建账号密码"));
    const first = vi.mocked(api).mock.calls[0][1]; expect(container.textContent).toContain("网络中断");
    await click(button("若已创建，用这组账密登录"));
    expect(vi.mocked(api).mock.calls[1]).toEqual(["login", first]); expect(button("进入我的知识空间")).toBeTruthy();
  });
  it("retains credentials after a failed retry and never silently rotates them", async () => {
    vi.mocked(api).mockRejectedValue(new Error("暂时不可用")); await render(); await click(button("一键创建账号密码"));
    const first = vi.mocked(api).mock.calls[0][1]; await click(button("重试创建这组账号"));
    expect(vi.mocked(api).mock.calls[1][1]).toEqual(first); expect(container.querySelectorAll("input[readonly]")).toHaveLength(2);
  });
  it("copies credentials only on demand and provides a fallback if clipboard access fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await render(); await click(button("一键创建账号密码")); expect(writeText).not.toHaveBeenCalled();
    await click(button("复制账密")); expect(container.textContent).toContain("复制不可用");
    writeText.mockResolvedValue(undefined); await click(button("复制账密"));
    expect(writeText.mock.calls[1][0]).toContain("明文密码"); expect(container.textContent).toContain("账密已复制");
    expect(button("进入我的知识空间").disabled).toBe(true);
  });
  it("keeps the existing manual login path", async () => {
    await render();
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(api).toHaveBeenCalledWith("login", { email: "", password: "", display_name: "" }); expect(onSuccess).toHaveBeenCalledOnce();
  });
  it("warns before leaving unsaved credentials and releases the warning after acknowledgement", async () => {
    await render(); await click(button("一键创建账号密码"));
    const leaving = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    await click(container.querySelector('input[type="checkbox"]')!);
    const savedLeaving = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(savedLeaving);
    expect(savedLeaving.defaultPrevented).toBe(false);
  });
});

describe("credential generation", () => {
  it("uses independent Web Crypto random bytes for each credential", () => {
    const first = generateCredentials(), second = generateCredentials();
    expect(first.email).not.toBe(second.email); expect(first.password).not.toBe(second.password);
    expect(first.password.length).toBe(35);
  });
  it("does not fall back to insecure randomness", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation(() => { throw new Error("unavailable"); });
    expect(() => generateCredentials()).toThrow("unavailable");
  });
  it("exports only the login origin, credentials and clear safekeeping warnings", () => {
    const text = credentialsText({ email: "synthetic@account.invalid", password: "synthetic-password" }, "https://zhishi.51wanai.com/?token=not-for-export");
    expect(text).toContain("https://zhishi.51wanai.com"); expect(text).not.toContain("token="); expect(text).toContain("不是邮箱"); expect(text).toContain("明文密码");
  });
});
