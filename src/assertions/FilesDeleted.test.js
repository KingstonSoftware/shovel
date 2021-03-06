import { FilesDeleted } from "./FilesDeleted"
import { createAssertNode, ScriptError, PathInfo } from "../utility"

test("assert", async () => {
  const container = {
    interpolator: (node) => node.value,
    process: {
      geteuid: () => 1,
      getgroups: () => [1, 2],
    },
    util: {
      pathInfo: async (path) => {
        if (path === "/somedir") {
          return new PathInfo({
            isFile: () => false,
            isDirectory: () => true,
          })
        } else if (path === "/somefile" || path === "/noaccess/file") {
          return new PathInfo({
            isFile: () => true,
            isDirectory: () => false,
          })
        } else if (path === "/") {
          return new PathInfo({
            isDirectory: () => true,
            isFile: () => false,
            mode: 0o777,
          })
        } else if (path === "/noaccess") {
          return new PathInfo({
            isDirectory: () => true,
            isFile: () => false,
            mode: 0o555,
          })
        } else {
          return new PathInfo()
        }
      },
    },
  }

  const assertion = new FilesDeleted(container)

  // Bad args
  await expect(
    assertion.assert(createAssertNode(assertion, { files: [1] }))
  ).rejects.toThrow(ScriptError)

  // Happy path
  await expect(
    assertion.assert(
      createAssertNode(assertion, {
        files: ["/notthere", "/alsonotthere"],
      })
    )
  ).resolves.toBe(true)

  // File exists
  await expect(
    assertion.assert(
      createAssertNode(assertion, {
        files: ["/somefile", "/notthere"],
      })
    )
  ).resolves.toBe(false)

  // Directory instead of file existing
  await expect(
    assertion.assert(
      createAssertNode(assertion, {
        files: ["/nothere", "/somedir"],
      })
    )
  ).rejects.toThrow(Error)

  // Cannot write to parent dir
  await expect(
    assertion.assert(
      createAssertNode(assertion, {
        files: ["/noaccess/file"],
      })
    )
  ).rejects.toThrow(Error)
})

test("rectify", async () => {
  const container = {
    fs: {
      unlink: jest.fn(async () => null),
    },
  }
  const assertion = new FilesDeleted(container)

  assertion.unlinkFilePaths = ["blah"]

  await expect(assertion.rectify()).resolves.toBeUndefined()
})

test("result", () => {
  const assertion = new FilesDeleted({})

  assertion.unlinkFilePaths = ["blah"]

  expect(assertion.result(true)).toEqual({ files: assertion.unlinkFilePaths })

  assertion.unlinkFilePaths = []
  assertion.filePaths = ["blah"]

  expect(assertion.result(false)).toEqual({ files: assertion.filePaths })
})
