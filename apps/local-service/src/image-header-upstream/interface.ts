// @ts-nocheck -- retain upstream bodies under stricter host indexed-access settings.
// image-size, MIT; Copyright 2013-Present Aditya Yadav.
// Fixed upstream commit e6e83a5578961de81f6d5834d90fb7430d8f29a5; ESM import specifiers and compiler directive only.
export interface ISize {
  width: number
  height: number
  orientation?: number
  type?: string
}

export type ISizeCalculationResult = {
  images?: ISize[]
} & ISize

export interface IImage {
  validate: (input: Uint8Array) => boolean
  calculate: (input: Uint8Array) => ISizeCalculationResult
}
