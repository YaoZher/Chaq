import type { ProviderKind, SkillDraft } from "@chaq/shared";
import type { LoginUser } from "./api";
import { userModelPresets } from "./provider-presets";

export type SkillKind = "friend" | "expert" | "partner" | "custom";

export type UserModelFormState = {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  embeddingModel: string;
};

export type UserModelTestStatus = {
  state: "idle" | "testing" | "ok" | "error";
  message: string;
};

export type FieldErrors = Record<string, string>;

export type ProfileFormState = {
  displayName: string;
  avatarUrl: string;
  email: string;
  emailCode: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export type AdminProviderFormState = {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelLabel: string;
  embeddingModel: string;
  embeddingTokenPrice: number;
  contextWindow: number;
  promptTokenPrice: number;
  completionTokenPrice: number;
  enabled: boolean;
};

export function validateUserModelFields(form: UserModelFormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.defaultModel.trim()) errors.defaultModel = "请输入模型 ID。";
  else if (form.defaultModel.trim().length > 160) errors.defaultModel = "模型 ID 不能超过 160 个字符。";
  if (form.embeddingModel.trim().length > 160) errors.embeddingModel = "Embedding 模型不能超过 160 个字符。";
  if (form.kind === "custom") {
    if (!form.baseUrl.trim()) errors.baseUrl = "请输入 API 接口地址。";
    else if (!isValidHttpUrl(form.baseUrl, true)) errors.baseUrl = "请输入有效的 HTTPS 地址。";
  }
  if (!form.id && !form.apiKey.trim()) errors.apiKey = "请输入 API Key。";
  if (form.apiKey.length > 5000) errors.apiKey = "API Key 长度异常，请检查后重试。";
  if (form.name.trim().length > 80) errors.name = "连接名称不能超过 80 个字符。";
  return errors;
}

export function normalizeUserModelForm(form: UserModelFormState): UserModelFormState {
  const preset = userModelPresets[form.kind];
  const defaultModel = form.defaultModel.trim();
  return {
    ...form,
    name: form.name.trim() || (form.kind === "custom" ? `自定义 · ${defaultModel}` : `${preset.name} 私有连接`),
    baseUrl: form.kind === "custom" ? form.baseUrl.trim().replace(/\/$/, "") : preset.baseUrl,
    apiKey: form.apiKey.trim(),
    defaultModel,
    embeddingModel: form.embeddingModel.trim()
  };
}

export function validateAdminProviderFields(form: AdminProviderFormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!String(form.name ?? "").trim()) errors.name = "请输入供应商名称。";
  if (!String(form.baseUrl ?? "").trim()) errors.baseUrl = "请输入 API 接口地址。";
  else if (!isValidHttpUrl(String(form.baseUrl), false)) errors.baseUrl = "请输入有效的 HTTP 或 HTTPS 地址。";
  if (!form.id && form.kind !== "ollama" && !String(form.apiKey ?? "").trim()) errors.apiKey = "请输入 API Key。";
  if (!String(form.modelId ?? "").trim()) errors.modelId = "请输入模型 ID。";
  if (!String(form.modelLabel ?? "").trim()) errors.modelLabel = "请输入模型显示名。";
  if (String(form.embeddingModel ?? "").trim().length > 160) errors.embeddingModel = "Embedding 模型不能超过 160 个字符。";
  if (!Number.isFinite(Number(form.contextWindow)) || Number(form.contextWindow) <= 0) errors.contextWindow = "上下文窗口必须大于 0。";
  if (!Number.isFinite(Number(form.promptTokenPrice)) || Number(form.promptTokenPrice) < 0) errors.promptTokenPrice = "单价不能小于 0。";
  if (!Number.isFinite(Number(form.completionTokenPrice)) || Number(form.completionTokenPrice) < 0) errors.completionTokenPrice = "单价不能小于 0。";
  if (!Number.isFinite(Number(form.embeddingTokenPrice)) || Number(form.embeddingTokenPrice) < 0) errors.embeddingTokenPrice = "单价不能小于 0。";
  return errors;
}

export function validateLoginFields(form: { username: string; password: string }): FieldErrors {
  return {
    username: form.username.trim() ? "" : "请输入邮箱或账号。",
    password: form.password ? "" : "请输入密码。"
  };
}

export function validateRegisterFields(form: { email: string; code: string; password: string; confirmPassword: string }): FieldErrors {
  const passwordError = !form.password
    ? "请输入密码。"
    : form.password.length < 8 || form.password.length > 64 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)
      ? "密码需要 8-64 位，并同时包含字母和数字。"
      : "";
  return {
    email: validateEmailField(form.email),
    code: form.code.trim() ? "" : "请输入邮箱验证码。",
    password: passwordError,
    confirmPassword: !form.confirmPassword ? "请再次输入密码。" : form.confirmPassword === form.password ? "" : "两次输入的密码不一致。"
  };
}

export function validateEmailField(value: string): string {
  const email = value.trim();
  if (!email) return "请输入邮箱地址。";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "" : "邮箱格式不正确。";
}

export function validateProfileFields(form: ProfileFormState, user?: LoginUser): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.displayName.trim()) errors.displayName = "请输入昵称。";
  else if (form.displayName.trim().length > 80) errors.displayName = "昵称不能超过 80 个字符。";
  const currentEmail = user?.email ?? user?.username ?? "";
  errors.email = validateEmailField(form.email);
  if (form.email.trim() && form.email.trim() !== currentEmail && !form.emailCode.trim()) errors.emailCode = "更换邮箱需要填写验证码。";
  const changingPassword = Boolean(form.currentPassword || form.newPassword || form.confirmPassword);
  if (changingPassword) {
    if (!form.currentPassword) errors.currentPassword = "请输入当前密码。";
    if (!form.newPassword) errors.newPassword = "请输入新密码。";
    else if (form.newPassword.length < 8 || form.newPassword.length > 64 || !/[A-Za-z]/.test(form.newPassword) || !/\d/.test(form.newPassword)) errors.newPassword = "新密码需要 8-64 位，并包含字母和数字。";
    if (!form.confirmPassword) errors.confirmPassword = "请再次输入新密码。";
    else if (form.confirmPassword !== form.newPassword) errors.confirmPassword = "两次输入的新密码不一致。";
  }
  return errors;
}

export function validateSkillDraft(draft: SkillDraft, creation?: { kind: SkillKind; expertField: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (!draft.name.trim()) errors.name = "请填写 Skill 名称。";
  else if (draft.name.trim().length > 80) errors.name = "Skill 名称不能超过 80 个字符。";
  if (!draft.description.trim()) errors.description = "请填写一句简介。";
  else if (draft.description.trim().length > 160) errors.description = "简介不能超过 160 个字符。";
  if (!draft.persona.trim()) errors.persona = creation?.kind === "expert" ? "请填写专业描述。" : "请填写人格设定。";
  if (!draft.tone.trim() && creation?.kind !== "expert" && creation?.kind !== "custom") errors.tone = "请填写相处语气。";
  if (creation && creation.kind === "expert" && !creation.expertField.trim()) errors.expertField = "请填写专业方向。";
  return errors;
}

export function isValidHttpUrl(value: string, httpsOnly: boolean): boolean {
  try {
    const url = new URL(value.trim());
    return httpsOnly ? url.protocol === "https:" : url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function hasFieldErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

export function clearFieldError(errors: FieldErrors, key: string): FieldErrors {
  if (!errors[key]) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

export function fieldClass(error?: string): string | undefined {
  return error ? "has-field-error" : undefined;
}
