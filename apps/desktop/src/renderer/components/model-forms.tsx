import React from "react";
import { Plus, Save, ShieldCheck } from "lucide-react";
import type { ProviderKind } from "@chaq/shared";
import { providerKinds, userModelPresets } from "../lib/provider-presets";
import type { AdminProviderFormState, FieldErrors, UserModelFormState, UserModelTestStatus } from "../lib/form-validation";
import { FormField } from "./form-field";

export function ModelForm(props: {
  form: UserModelFormState;
  setForm: (form: UserModelFormState) => void;
  onKindChange: (kind: ProviderKind) => void;
  onTest: () => void;
  onSave: () => void;
  onReset: () => void;
  status: UserModelTestStatus;
  errors: FieldErrors;
  clearError: (key: string) => void;
}): JSX.Element {
  const { form, setForm } = props;
  const preset = userModelPresets[form.kind];
  const update = <K extends keyof UserModelFormState>(key: K, value: UserModelFormState[K]) => {
    setForm({ ...form, [key]: value });
    props.clearError(key);
  };
  return (
    <div className="panel form-panel">
      <div className="panel-title-row">
        <h3>{form.id ? "编辑自己的模型" : "添加自己的模型"}</h3>
        <button type="button" onClick={props.onReset}><Plus size={16} />新建</button>
      </div>
      <FormField label="模型厂商">
        <select value={form.kind} onChange={(event) => props.onKindChange(event.target.value as ProviderKind)}>
          {providerKinds.filter((kind) => kind !== "ollama").map((kind) => <option key={kind} value={kind}>{userModelPresets[kind].name}</option>)}
        </select>
      </FormField>
      {form.kind === "custom" ? (
        <FormField label="API 接口地址" error={props.errors.baseUrl} hint="填写兼容 OpenAI Chat Completions 的 HTTPS 根地址。">
          <input aria-invalid={Boolean(props.errors.baseUrl)} value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" />
        </FormField>
      ) : (
        <div className="model-endpoint-summary"><ShieldCheck size={17} /><span><strong>{preset.name} 官方接口</strong><small>{preset.baseUrl}</small></span></div>
      )}
      <FormField label="模型 ID" error={props.errors.defaultModel} hint={preset.defaultModel ? `已预填推荐模型 ${preset.defaultModel}，也可以改成账号实际可用的模型。` : "填写服务商提供的模型标识。"}>
        <input aria-invalid={Boolean(props.errors.defaultModel)} value={form.defaultModel} onChange={(event) => update("defaultModel", event.target.value)} placeholder="例如：deepseek-chat" />
      </FormField>
      <FormField label="Embedding 模型（可选）" error={props.errors.embeddingModel} hint="用于 Agent 知识库向量检索。留空时自动回退本地向量。">
        <input aria-invalid={Boolean(props.errors.embeddingModel)} value={form.embeddingModel} onChange={(event) => update("embeddingModel", event.target.value)} placeholder={preset.embeddingModel || "例如：text-embedding-3-small"} />
      </FormField>
      <FormField label={form.id ? "API Key（留空则继续使用已保存密钥）" : "API Key"} error={props.errors.apiKey} hint="只上传到服务器加密保存，客户端不会回显。">
        <input aria-invalid={Boolean(props.errors.apiKey)} type="password" value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={form.id ? "无需更换可留空" : "请输入厂商提供的 API Key"} />
      </FormField>
      <details className="model-advanced-fields">
        <summary>高级设置</summary>
        <FormField label="连接名称（可选）" error={props.errors.name} hint="仅用于区分你保存的多个连接。">
          <input aria-invalid={Boolean(props.errors.name)} value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={`${preset.name} 私有连接`} />
        </FormField>
      </details>
      <div className="model-form-actions">
        <button type="button" onClick={props.onTest} disabled={props.status.state === "testing"}><ShieldCheck size={16} />云端检测</button>
        <button className="primary-button" onClick={props.onSave}><Save size={16} />保存模型</button>
      </div>
      {props.status.message && <div className={`model-test-status ${props.status.state}`}>{props.status.message}</div>}
    </div>
  );
}

export function AdminProviderForm({ form, setForm, onKindChange, onSave, errors, clearError }: { form: AdminProviderFormState; setForm: (form: AdminProviderFormState) => void; onKindChange: (kind: ProviderKind) => void; onSave: () => void; errors: FieldErrors; clearError: (key: string) => void }): JSX.Element {
  const update = <K extends keyof AdminProviderFormState>(key: K, value: AdminProviderFormState[K]) => {
    setForm({ ...form, [key]: value });
    clearError(key);
  };
  return (
    <div className="panel form-panel">
      <h3>平台云模型</h3>
      <FormField label="模型厂商">
        <select value={form.kind} onChange={(event) => onKindChange(event.target.value as ProviderKind)}>
          {providerKinds.map((kind) => <option key={kind} value={kind}>{userModelPresets[kind].name}</option>)}
        </select>
      </FormField>
      <FormField label="供应商名称" error={errors.name}><input aria-invalid={Boolean(errors.name)} value={form.name} onChange={(event) => update("name", event.target.value)} /></FormField>
      <FormField label="API 接口地址" error={errors.baseUrl}><input aria-invalid={Boolean(errors.baseUrl)} value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" /></FormField>
      <FormField label={form.id ? "API Key（留空保留原密钥）" : "API Key"} error={errors.apiKey}><input aria-invalid={Boolean(errors.apiKey)} type="password" value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} /></FormField>
      <div className="form-grid-two">
        <FormField label="模型 ID" error={errors.modelId}><input aria-invalid={Boolean(errors.modelId)} value={form.modelId} onChange={(event) => update("modelId", event.target.value)} /></FormField>
        <FormField label="模型显示名" error={errors.modelLabel}><input aria-invalid={Boolean(errors.modelLabel)} value={form.modelLabel} onChange={(event) => update("modelLabel", event.target.value)} /></FormField>
        <FormField label="Embedding 模型" error={errors.embeddingModel}><input aria-invalid={Boolean(errors.embeddingModel)} value={form.embeddingModel} onChange={(event) => update("embeddingModel", event.target.value)} placeholder="可留空" /></FormField>
        <FormField label="上下文窗口" error={errors.contextWindow}><input aria-invalid={Boolean(errors.contextWindow)} type="number" min="1" value={form.contextWindow} onChange={(event) => update("contextWindow", Number(event.target.value))} /></FormField>
        <FormField label="输入 Token 单价" error={errors.promptTokenPrice}><input aria-invalid={Boolean(errors.promptTokenPrice)} type="number" min="0" step="0.001" value={form.promptTokenPrice} onChange={(event) => update("promptTokenPrice", Number(event.target.value))} /></FormField>
        <FormField label="输出 Token 单价" error={errors.completionTokenPrice}><input aria-invalid={Boolean(errors.completionTokenPrice)} type="number" min="0" step="0.001" value={form.completionTokenPrice} onChange={(event) => update("completionTokenPrice", Number(event.target.value))} /></FormField>
        <FormField label="Embedding Token 单价" error={errors.embeddingTokenPrice}><input aria-invalid={Boolean(errors.embeddingTokenPrice)} type="number" min="0" step="0.001" value={form.embeddingTokenPrice} onChange={(event) => update("embeddingTokenPrice", Number(event.target.value))} /></FormField>
      </div>
      <button onClick={onSave}><Save size={16} />保存供应商</button>
    </div>
  );
}
