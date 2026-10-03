// @ts-nocheck -- retain upstream bodies under stricter host indexed-access settings.
// image-size, MIT; Copyright 2013-Present Aditya Yadav.
// Fixed upstream commit e6e83a5578961de81f6d5834d90fb7430d8f29a5; ESM import specifiers and compiler directive only.
import type { IImage } from './interface.js'
import { readUInt16LE, toUTF8String } from './utils.js'

const gifRegexp = /^GIF8[79]a/
export const GIF: IImage = {
  validate: (input) => gifRegexp.test(toUTF8String(input, 0, 6)),

  calculate: (input) => ({
    height: readUInt16LE(input, 8),
    width: readUInt16LE(input, 6),
  }),
}
