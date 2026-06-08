export interface Base64UploadPayload {
  fileName: string;
  mimeType: string;
  base64Data: string;
}

export function stripDataUrlPrefix(value: string) {
  const match = value.match(/^data:.+;base64,(.+)$/);
  return match?.[1] ?? value;
}

export async function fileToBase64Payload(file: File): Promise<Base64UploadPayload> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });

  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    base64Data: stripDataUrlPrefix(dataUrl),
  };
}

export function fileToAssetUploadFormData(type: string, file: File) {
  const formData = new FormData();
  formData.set("type", type);
  formData.set("file", file, file.name);
  formData.set("fileName", file.name);
  formData.set("mimeType", file.type || "application/octet-stream");
  return formData;
}
