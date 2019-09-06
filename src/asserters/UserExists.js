import fs from "fs-extra"
import childProcess from "child-process-promise"
import os from "os"
import * as util from "../util"

/*
Asserts and ensures that a user exists with UID, GID, shell and/or system priveges.

Example:

{
  assert: "UserExists",
  with: {
    name: <string>,
    gid: <number>,
    uid: <number>,
    system: <bool>,
    shell: <string>,
  }
}
*/

// TODO: Support uid
// TODO: Support gid
// TODO: Support system
// TODO: Support shell

export class UserExists {
  constructor(container) {
    this.fs = container.fs || fs
    this.os = container.os || os
    this.util = container.util || util
    this.childProcess = container.childProcess || childProcess
    this.expandStringNode = container.expandStringNode
  }

  async assert(assertNode) {
    const withNode = assertNode.value.with
    const { name: nameNode } = withNode.value

    if (!nameNode || nameNode.type !== "string") {
      throw new ScriptError(
        "'name' must be supplied and be a string",
        nameNode || withNode
      )
    }

    this.expandedName = this.expandStringNode(nameNode)

    const ok =
      (await this.util.getUsers(this.fs)).find(
        (user) => user.name === this.expandedName
      ) !== undefined

    if (!ok && !util.runningAsRoot(this.os)) {
      throw new ScriptError(
        "Only root user can add or modify users",
        assertNode
      )
    }

    return ok
  }

  async rectify() {
    await this.childProcess.exec(`useradd ${this.expandedName}`)
  }

  result() {
    return { name: this.expandedName }
  }
}
