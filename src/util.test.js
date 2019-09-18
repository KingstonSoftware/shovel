import * as util from "./util"
import stream from "stream"
import { createNode } from "./testUtil"
import { ScriptError } from "./ScriptError"

let container = null

// TODO: Get coverage to 100%

beforeEach(() => {
  container = {
    fs: {
      lstat: jest.fn((path) => {
        if (path === "somedir") {
          return {
            isDirectory: () => true,
          }
        } else {
          return {
            isDirectory: () => false,
          }
        }
      }),
      readFile: jest.fn((path, options) => {
        if (path === "/etc/passwd") {
          return `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
bin:x:2:2:bin:/bin:/usr/sbin/nologin
sys:x:3:3:sys:/dev:/usr/sbin/nologin
sync:x:4:65534:sync:/bin:/bin/sync
games:x:5:60:games:/usr/games:/usr/sbin/nologin
man:x:6:12:man:/var/cache/man:/usr/sbin/nologin
lp:x:7:7:lp:/var/spool/lpd:/usr/sbin/nologin
mail:x:8:8:mail:/var/mail:/usr/sbin/nologin
news:x:9:9:news:/var/spool/news:/usr/sbin/nologin
uucp:x:10:10:uucp:/var/spool/uucp:/usr/sbin/nologin
proxy:x:13:13:proxy:/bin:/usr/sbin/nologin
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
someuser:x:1000:1000:Some User:/home/someuser:/bin/bash
sshd:x:110:65534::/run/sshd:/usr/sbin/nologin
ntp:x:111:113::/nonexistent:/usr/sbin/nologin`
        } else if (path === "/etc/group") {
          return `root:x:0:
daemon:x:1:
bin:x:2:
sys:x:3:
adm:x:4:syslog,someuser
tty:x:5:
disk:x:6:
lp:x:7:
mail:x:8:
news:x:9:
uucp:x:10:
man:x:12:
cdrom:x:24:someuser
floppy:x:25:
tape:x:26:
sudo:x:27:someuser`
        }
      }),
    },
    childProcess: {},
  }
})
const testString = "the quick brown fox jumps over the lazy dog"

test("generateDigestFromFile", async () => {
  const fs = {
    createReadStream: jest.fn((fileName) => {
      return new stream.Readable({
        read(size) {
          this.push(testString)
          this.push(null)
        },
      })
    }),
  }

  await expect(util.generateDigestFromFile(fs, testString)).resolves.toBe(
    "05c6e08f1d9fdafa03147fcb8f82f124c76d2f70e3d989dc8aadb5e7d7450bec"
  )
})

test("generateDigest", () => {
  expect(util.generateDigest(testString)).toBe(
    "05c6e08f1d9fdafa03147fcb8f82f124c76d2f70e3d989dc8aadb5e7d7450bec"
  )
})

test("fileExists", async () => {
  const fs = {
    lstat: jest.fn((path) => {
      if (path === "there") {
        return {
          isFile: () => true,
        }
      } else {
        throw new Error()
      }
    }),
  }
  await expect(util.fileExists(fs, "there")).resolves.toBe(true)
  await expect(util.fileExists(fs, "notthere")).resolves.toBe(false)
})

test("dirExists", async () => {
  const fs = {
    lstat: jest.fn((path) => {
      if (path === "there") {
        return {
          isDirectory: () => true,
        }
      } else {
        throw new Error()
      }
    }),
  }
  await expect(util.dirExists(fs, "there")).resolves.toBe(true)
  await expect(util.dirExists(fs, "notthere")).resolves.toBe(false)
})

test("pipeToPromise", async () => {
  let readable = new stream.Readable({
    read(size) {
      this.push(testString)
      this.push(null)
    },
  })
  let writeable = new stream.Writable({
    write(chunk, encoding, callback) {
      callback()
    },
  })

  await expect(util.pipeToPromise(readable, writeable)).resolves.toBeUndefined()

  readable = new stream.Readable({
    read(size) {
      process.nextTick(() => this.emit("error", new Error()))
    },
  })

  await expect(util.pipeToPromise(readable, writeable)).rejects.toThrow(Error)

  // Readable is only useful once
  readable = new stream.Readable({
    read(size) {
      this.push(testString)
      this.push(null)
    },
  })
  writeable = new stream.Writable({
    write(chunk, encoding, callback) {
      callback(new Error())
    },
  })

  await expect(util.pipeToPromise(readable, writeable)).rejects.toThrow(Error)
})

test("runningAsRoot", async () => {
  const os = {
    userInfo: jest.fn(() => ({
      uid: 0,
    })),
  }

  expect(util.runningAsRoot(os)).toBe(true)
})

test("getUsers", async () => {
  await expect(util.getUsers(container.fs)).resolves.toContainEqual({
    name: "mail",
    password: "x",
    uid: 8,
    gid: 8,
    name: "mail",
    homeDir: "/var/mail",
    shell: "/usr/sbin/nologin",
    comment: "mail",
  })
})

test("getGroups", async () => {
  await expect(util.getGroups(container.fs)).resolves.toContainEqual({
    name: "adm",
    password: "x",
    gid: 4,
    users: ["syslog", "someuser"],
  })
})

test("parseOwnerNode", async () => {
  expect(util.parseOwnerNode([], [], null)).toEqual({})

  expect(util.parseOwnerNode([], [], createNode("test.json5", {}))).toEqual({})

  expect(
    util.parseOwnerNode(
      [{ name: "root", uid: 0 }],
      [{ name: "wheel", gid: 0 }],
      createNode("test.json5", {
        user: "root",
        group: "wheel",
      })
    )
  ).toEqual({ uid: 0, gid: 0 })

  expect(
    util.parseOwnerNode(
      [{ name: "root", uid: 0 }],
      [{ name: "wheel", gid: 0 }],
      createNode("test.json5", {
        user: 0,
        group: 0,
      })
    )
  ).toEqual({ uid: 0, gid: 0 })

  expect(() => util.parseOwnerNode([], [], createNode("test.json5"))).toThrow(
    ScriptError
  )

  expect(() =>
    util.parseOwnerNode([], [], createNode("test.json5", { user: true }))
  ).toThrow(ScriptError)

  expect(() =>
    util.parseOwnerNode(
      [],
      [],
      createNode("test.json5", {
        user: 0,
      })
    )
  ).toThrow(Error)

  expect(() =>
    util.parseOwnerNode([], [], createNode("test.json5", { group: true }))
  ).toThrow(ScriptError)

  expect(() =>
    util.parseOwnerNode(
      [],
      [],
      createNode("test.json5", {
        group: 0,
      })
    )
  ).toThrow(Error)
})

test("parseModeNode", async () => {
  const node = createNode("test.json5", {
    user: "rwx",
    group: "r-x",
    other: "r--",
  })
  expect(util.parseModeNode(node)).toBe(0o754)
})
