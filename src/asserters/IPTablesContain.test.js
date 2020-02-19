import { IPTablesContain } from "./IPTablesContain"
import { createAssertNode } from "../testUtil"
import { ScriptError } from "../ScriptError"
import { PathInfo } from "../util"

test("assert", async () => {
  const container = {
    interpolator: (node) => node.value,
    childProcess: {
      exec: async (command) => {
        if (command === "iptables-save") {
          return {
            stdout: `
# Generated by iptables-save v1.6.1 on Thu Feb 01 00:06:03 2020
*nat
:PREROUTING ACCEPT [69490240:47107157689]
:INPUT ACCEPT [666051:39068964]
:OUTPUT ACCEPT [1804997:110857323]
:POSTROUTING ACCEPT [484443:31272157]
-A POSTROUTING -s 10.10.0.0/16 -o eno1 -j MASQUERADE
COMMIT
# Completed on Thu Feb 13 00:06:03 2020
# Generated by iptables-save v1.6.1 on Thu Feb 01 00:06:03 2020
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:f2b-sshd - [0:0]
-A INPUT -p tcp -m multiport --dports 22 -j f2b-sshd
-A INPUT -i eno2 -p tcp -m tcp --dport 8300 -j ACCEPT
-A INPUT -j DROP
-A FORWARD -i eno2 -o eno1 -j ACCEPT
-A FORWARD -j DROP
-A OUTPUT -d 8.8.4.4/32 -o eno1 -p udp -m udp --dport 53 -j ACCEPT
-A OUTPUT -j DROP
-A f2b-sshd -j RETURN
COMMIT
# Completed on Thu Feb 13 00:06:03 2020`,
          }
        }
      },
    },
  }

  const asserter = new IPTablesContain(container)

  // Bad arguments
  await expect(asserter.assert(createAssertNode(asserter, {}))).rejects.toThrow(
    ScriptError
  )
  await expect(
    asserter.assert(createAssertNode(asserter, { file: 1 }))
  ).rejects.toThrow(ScriptError)
  await expect(
    asserter.assert(createAssertNode(asserter, { contents: "", ignore: 1 }))
  ).rejects.toThrow(ScriptError)
  await expect(
    asserter.assert(
      createAssertNode(asserter, { contents: "", ignore: { x: 1 } })
    )
  ).rejects.toThrow(ScriptError)
  await expect(
    asserter.assert(
      createAssertNode(asserter, { contents: "", ignore: { x: [1] } })
    )
  ).rejects.toThrow(ScriptError)

  const rules = `
  # New rules
  *nat
  -A POSTROUTING -s 10.10.0.0/16 -o eno1 -j MASQUERADE
  COMMIT
  *filter
  -A INPUT -i eno2 -p tcp -m tcp --dport 8300 -j ACCEPT
  -A INPUT -j DROP
  -A FORWARD -i eno2 -o eno1 -j ACCEPT
  -A FORWARD -j DROP
  -A OUTPUT -d 8.8.4.4/32 -o eno1 -p udp -m udp --dport 53 -j ACCEPT
  -A OUTPUT -j DROP
  COMMIT`
  const shorterRules = "*nat\nCOMMIT\n*filter\nCOMMIT"
  const longerRules = `
*nat
-A POSTROUTING -s 10.10.0.0/16 -o eno1 -j MASQUERADE
-A POSTROUTING -s 10.20.0.0/16 -o eno1 -j MASQUERADE
COMMIT
*filter
-A INPUT -p tcp -m multiport --dports 22 -j f2b-sshd
-A INPUT -i eno2 -p tcp -m tcp --dport 8300 -j ACCEPT
-A INPUT -j DROP
-A FORWARD -i eno2 -o eno1 -j ACCEPT
-A FORWARD -j DROP
-A OUTPUT -d 8.8.4.4/32 -o eno1 -p udp -m udp --dport 53 -j ACCEPT
-A OUTPUT -j DROP
COMMIT
`

  // Happy path
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        contents: rules,
        ignore: {
          filter: ["^-A INPUT.*-j f2b-sshd$", "^-A f2b-sshd.*$"],
        },
      })
    )
  ).resolves.toBe(true)

  // New has missing tables
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        contents: "#Bogus",
      })
    )
  ).resolves.toBe(false)

  // New has missing rules
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        contents: shorterRules,
      })
    )
  ).resolves.toBe(false)

  // New has extra rules
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        contents: longerRules,
        ignore: {
          filter: ["^-A INPUT.*-j f2b-sshd$", "^-A f2b-sshd.*$"],
        },
      })
    )
  ).resolves.toBe(false)

  // No iptables installed
  container.childProcess.exec = async () => {
    throw Error()
  }
  await expect(
    asserter.assert(
      createAssertNode(asserter, {
        contents: rules,
      })
    )
  ).rejects.toThrow(ScriptError)
})

test("rectify", async () => {
  const container = {
    tempy: {
      file: () => "/tmp/temp.txt",
    },
    fs: {
      writeFile: async () => undefined,
    },
    childProcess: {
      exec: async () => ({ stdout: "" }),
    },
  }
  const asserter = new IPTablesContain(container)

  asserter.contents = "xyz\n"

  await expect(asserter.rectify()).resolves.toBeUndefined()
})

test("result", () => {
  const asserter = new IPTablesContain({})

  asserter.contents = "some contents"

  expect(asserter.result()).toEqual({
    contents: asserter.contents,
  })
})
