import zip from "adm-zip"
import * as assert from "assert"
import * as fs from "fs-extra"
import * as http from "http"
import * as os from "os"
import * as path from "path"
import * as tar from "tar-fs"
import * as zlib from "zlib"
import { LatestResponse, UpdateHttpProvider } from "../src/node/app/update"
import { AuthType } from "../src/node/http"
import { SettingsProvider, UpdateSettings } from "../src/node/settings"
import { tmpdir } from "../src/node/util"

describe("update", () => {
  const archivePaths = {
    loose: path.join(tmpdir, "tests/updates/code-server-loose-source"),
    binary: path.join(tmpdir, "tests/updates/code-server-binary-source"),
  }

  let useBinary = false
  let version = "1.0.0"
  let spy: string[] = []
  const server = http.createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
    if (!request.url) {
      throw new Error("no url")
    }
    spy.push(request.url)
    response.writeHead(200)
    if (request.url === "/latest") {
      const latest: LatestResponse = {
        name: version,
      }
      return response.end(JSON.stringify(latest))
    }

    const path =
      (useBinary ? archivePaths.binary : archivePaths.loose) + (request.url.endsWith(".tar.gz") ? ".tar.gz" : ".zip")

    const stream = fs.createReadStream(path)
    stream.on("error", (error: NodeJS.ErrnoException) => {
      response.writeHead(500)
      response.end(error.message)
    })
    response.writeHead(200)
    stream.on("close", () => response.end())
    stream.pipe(response)
  })

  const jsonPath = path.join(tmpdir, "tests/updates/update.json")
  const settings = new SettingsProvider<UpdateSettings>(jsonPath)

  let _provider: UpdateHttpProvider | undefined
  const provider = (): UpdateHttpProvider => {
    if (!_provider) {
      const address = server.address()
      if (!address || typeof address === "string" || !address.port) {
        throw new Error("unexpected address")
      }
      _provider = new UpdateHttpProvider(
        {
          auth: AuthType.None,
          base: "/update",
          commit: "test",
        },
        true,
        `http://${address.address}:${address.port}/latest`,
        `http://${address.address}:${address.port}/download/{{VERSION}}/{{RELEASE_NAME}}`,
        settings,
      )
    }
    return _provider
  }

  before(async () => {
    await fs.remove(path.join(tmpdir, "tests/updates"))
    await Promise.all(Object.values(archivePaths).map((p) => fs.mkdirp(path.join(p, "code-server"))))

    await Promise.all([
      fs.writeFile(path.join(archivePaths.binary, "code-server", "code-server"), "BINARY"),
      fs.writeFile(path.join(archivePaths.loose, "code-server", "code-server"), `console.log("UPDATED")`),
      fs.writeFile(path.join(archivePaths.loose, "code-server", "node"), `NODE BINARY`),
    ])

    await Promise.all(
      Object.values(archivePaths).map((p) => {
        return Promise.all([
          new Promise((resolve, reject) => {
            const write = fs.createWriteStream(p + ".tar.gz")
            const compress = zlib.createGzip()
            compress.pipe(write)
            compress.on("error", (error) => compress.destroy(error))
            compress.on("close", () => write.end())
            tar.pack(p).pipe(compress)
            write.on("close", reject)
            write.on("finish", () => {
              resolve()
            })
          }),
          new Promise((resolve, reject) => {
            const zipFile = new zip()
            zipFile.addLocalFolder(p)
            zipFile.writeZip(p + ".zip", (error) => {
              return error ? reject(error) : resolve(error)
            })
          }),
        ])
      }),
    )

    await new Promise((resolve, reject) => {
      server.on("error", reject)
      server.on("listening", resolve)
      server.listen({
        port: 0,
        host: "localhost",
      })
    })
  })

  after(() => {
    server.close()
  })

  beforeEach(() => {
    spy = []
  })

  it("should get the latest", async () => {
    version = "2.1.0"

    const p = provider()
    const now = Date.now()
    const update = await p.getUpdate()

    assert.deepEqual({ update }, await settings.read())
    assert.equal(isNaN(update.checked), false)
    assert.equal(update.checked < Date.now() && update.checked >= now, true)
    assert.equal(update.version, "2.1.0")
    assert.deepEqual(spy, ["/latest"])
  })

  it("should keep existing information", async () => {
    version = "3.0.1"

    const p = provider()
    const now = Date.now()
    const update = await p.getUpdate()

    assert.deepEqual({ update }, await settings.read())
    assert.equal(isNaN(update.checked), false)
    assert.equal(update.checked < now, true)
    assert.equal(update.version, "2.1.0")
    assert.deepEqual(spy, [])
  })

  it("should force getting the latest", async () => {
    version = "4.1.1"

    const p = provider()
    const now = Date.now()
    const update = await p.getUpdate(true)

    assert.deepEqual({ update }, await settings.read())
    assert.equal(isNaN(update.checked), false)
    assert.equal(update.checked < Date.now() && update.checked >= now, true)
    assert.equal(update.version, "4.1.1")
    assert.deepEqual(spy, ["/latest"])
  })

  it("should get latest after interval passes", async () => {
    const p = provider()
    await p.getUpdate()
    assert.deepEqual(spy, [])

    let checked = Date.now() - 1000 * 60 * 60 * 23
    await settings.write({ update: { checked, version } })
    await p.getUpdate()
    assert.deepEqual(spy, [])

    checked = Date.now() - 1000 * 60 * 60 * 25
    await settings.write({ update: { checked, version } })

    const update = await p.getUpdate()
    assert.notEqual(update.checked, checked)
    assert.deepEqual(spy, ["/latest"])
  })

  it("should check if it's the current version", async () => {
    version = "9999999.99999.9999"

    const p = provider()
    let update = await p.getUpdate(true)
    assert.equal(p.isLatestVersion(update), false)

    version = "0.0.0"
    update = await p.getUpdate(true)
    assert.equal(p.isLatestVersion(update), true)

    // Old version format; make sure it doesn't report as being later.
    version = "999999.9999-invalid999.99.9"
    update = await p.getUpdate(true)
    assert.equal(p.isLatestVersion(update), true)
  })

  it("should download and apply an update", async () => {
    version = "9999999.99999.9999"

    const p = provider()
    const update = await p.getUpdate(true)

    // Create an existing version.
    const destination = path.join(tmpdir, "tests/updates/code-server")
    await fs.mkdirp(destination)
    const entry = path.join(destination, "code-server")
    await fs.writeFile(entry, `console.log("OLD")`)
    assert.equal(`console.log("OLD")`, await fs.readFile(entry, "utf8"))

    // Updating should replace the existing version.
    await p.downloadUpdate(update, destination)
    assert.equal(`console.log("UPDATED")`, await fs.readFile(entry, "utf8"))

    // Should still work if there is no existing version somehow.
    await fs.remove(destination)
    await p.downloadUpdate(update, destination)
    assert.equal(`console.log("UPDATED")`, await fs.readFile(entry, "utf8"))

    // Try the other platform.
    const altTarget = os.platform() === "darwin" ? "linux" : "darwin"
    await fs.writeFile(entry, `console.log("OLD")`)
    await p.downloadUpdate(update, destination, altTarget)
    assert.equal(`console.log("UPDATED")`, await fs.readFile(entry, "utf8"))

    // Extracting a binary should also work.
    useBinary = true
    await p.downloadUpdate(update, destination)
    assert.equal(`BINARY`, await fs.readFile(destination, "utf8"))

    // Back to flat files.
    useBinary = false
    await fs.remove(destination)
    await p.downloadUpdate(update, destination)
    assert.equal(`console.log("UPDATED")`, await fs.readFile(entry, "utf8"))

    const target = os.platform()
    const targetExt = target === "darwin" ? "zip" : "tar.gz"
    const altTargetExt = altTarget === "darwin" ? "zip" : "tar.gz"
    assert.deepEqual(spy, [
      "/latest",
      `/download/${version}/code-server-${version}-${target}-x86_64.${targetExt}`,
      `/download/${version}/code-server-${version}-${target}-x86_64.${targetExt}`,
      `/download/${version}/code-server-${version}-${altTarget}-x86_64.${altTargetExt}`,
      `/download/${version}/code-server-${version}-${target}-x86_64.${targetExt}`,
      `/download/${version}/code-server-${version}-${target}-x86_64.${targetExt}`,
    ])
  })
})
