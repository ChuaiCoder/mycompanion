export interface CharacterParams {
  id: string;
}

export interface CharacterExportQuery {
  format?: string;
}

export interface IdParams {
  id: string;
}

export interface PluginAssetParams extends IdParams {
  "*": string;
}

export interface SecretCodec {
  seal(value: string): string;
  unseal(value: string): string;
}
