import { FileCopied } from "./FileCopied"
import { createAssertNode } from "../testUtil"
import { ScriptError } from "../ScriptError"
import { PathInfo } from "../util"

test("assert", async () => {
  const container = {
    interpolator: (node) => node.value,
    util: {
      pathInfo: async (path) => {
        if (path === "/notthere" || path === "/noaccess/file") {
          return new PathInfo()
        } else if (path === "/noaccess") {
          return new PathInfo({
            isFile: () => false,
            isDirectory: () => true,
            mode: 0o555,
          })
        } else {
          return new PathInfo({
            isFile: () => true,
            isDirectory: () => false,
            mode: 0o777,
          })
        }
      },
      generateDigestFromFile: async (path) => {
        if (path === "/badfile") {
          return "0987654321"
        } else {
          return "1234567890"
        }
      },
    },
  }

  const asserter = new FileCopied(container)

  // Bad args
  await expect(asserter.assert(createAssertNode(asserter, {}))).rejects.toThrow(
    ScriptError
  )
  await expect(
    asserter.assert(createAssertNode(asserter, { fromFile: 1 }))
  ).rejects.toThrow(ScriptError)
  await expect(
    asserter.assert(createAssertNode(asserter, { fromFile: "" }))
  ).rejects.toThrow(ScriptError)
  await expect(
    asserter.assert(createAssertNode(asserter, { fromFile: "", toFile: 1 }))
  ).rejects.toThrow(ScriptError)

  // With files the same
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        fromFile: "/somefile",
        toFile: "/otherfile",
      })
    )
  ).resolves.toBe(true)

  // With fromFile file non-existent
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        fromFile: "/notthere",
        toFile: "/otherfile",
      })
    )
  ).rejects.toThrow(ScriptError)

  // With toFile file non-existent
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        fromFile: "/somefile",
        toFile: "/notthere",
      })
    )
  ).resolves.toBe(false)

  // With different files
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        fromFile: "/somefile",
        toFile: "/badfile",
      })
    )
  ).resolves.toBe(false)

  // With toPath directory not writable
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        fromFile: "/somefile",
        toFile: "/noaccess/file",
      })
    )
  ).rejects.toThrow(ScriptError)
})

test("rectify", async () => {
  const asserter = new FileCopied({
    fs: {
      copy: async () => undefined,
    },
  })

  asserter.fromFilePath = "/blah"
  asserter.toFilePath = "/blurp"

  await expect(asserter.rectify()).resolves.toBeUndefined()
})

test("result", async () => {
  const asserter = new FileCopied({})

  asserter.fromFilePath = "/blah"
  asserter.toFilePath = "/blurp"

  expect(asserter.result()).toEqual({
    fromFile: asserter.fromFilePath,
    toFile: asserter.toFilePath,
  })
})
