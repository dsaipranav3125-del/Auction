import express from 'express'
import http from 'http'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { Server } from 'socket.io'
import { PLAYERS } from '../src/data/players.js'

const PORT = globalThis.process?.env?.PORT || 4000
const DEFAULT_BUDGET = 100
const BASE_COUNTDOWN_SECONDS = 18
const RESET_COUNTDOWN_SECONDS = 12
const ANTI_SNIPING_THRESHOLD_SECONDS = 5
const ANTI_SNIPING_EXTENSION_SECONDS = 10
const rooms = new Map()
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(currentDir, '../dist')

const playerMap = new Map(PLAYERS.map((player) => [player.id, player]))

function createRoom(code) {
  const room = {
    code,
    createdAt: Date.now(),
    owners: [],
    adminId: null,
    playerOrder: PLAYERS.map((player) => player.id),
    currentIndex: -1,
    sold: [],
    unsold: [],
    auction: null,
    paused: false,
    version: 0,
  }

  rooms.set(code, room)
  return room
}

function getRoom(code) {
  return rooms.get(code) ?? createRoom(code)
}

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
}

function normalizeName(value, fallback) {
  const trimmed = (value ?? '').trim()
  return trimmed || fallback
}

function toRoleBucket(role) {
  const lower = role.toLowerCase()
  if (lower.includes('keeper')) return 'keeper'
  if (lower.includes('all-rounder')) return 'allRounder'
  if (lower.includes('bowler') || lower.includes('spinner')) return 'bowler'
  return 'batter'
}

function getOwnerSummary(owner) {
  const spend = owner.squad.reduce((sum, player) => sum + player.price, 0)
  const roleCounts = owner.squad.reduce(
    (acc, player) => {
      acc[toRoleBucket(player.role)] += 1
      return acc
    },
    { batter: 0, bowler: 0, allRounder: 0, keeper: 0 },
  )

  return {
    id: owner.id,
    socketId: owner.socketId,
    name: owner.name,
    teamName: owner.teamName,
    budget: owner.budget,
    spent: spend,
    squadSize: owner.squad.length,
    squad: owner.squad,
    roleCounts,
    isAdmin: owner.id === owner.room.adminId,
  }
}

function computeSuggestion(room, owner) {
  const needs = []
  const roleCounts = owner.squad.reduce(
    (acc, player) => {
      acc[toRoleBucket(player.role)] += 1
      return acc
    },
    { batter: 0, bowler: 0, allRounder: 0, keeper: 0 },
  )

  if (roleCounts.keeper === 0) needs.push('keeper')
  if (roleCounts.bowler < 3) needs.push('bowler')
  if (roleCounts.allRounder < 2) needs.push('allRounder')
  if (roleCounts.batter < 3) needs.push('batter')

  const remainingPlayers = room.playerOrder
    .slice(room.currentIndex + 1)
    .map((id) => playerMap.get(id))
    .filter(Boolean)
    .filter((player) => player.basePrice <= owner.budget)

  const scoredPlayers = remainingPlayers
    .map((player) => {
      const bucket = toRoleBucket(player.role)
      const roleBoost = needs.includes(bucket) ? 14 : 0
      const budgetEfficiency = Math.max(0, 12 - player.basePrice)
      const score = player.rating + roleBoost + budgetEfficiency

      return {
        playerId: player.id,
        name: player.name,
        role: player.role,
        price: player.basePrice,
        rationale: needs.includes(bucket)
          ? `AI scout flags ${player.role} as a current squad gap.`
          : `AI scout likes the value-for-budget fit at ${player.basePrice.toFixed(1)} cr.`,
        score,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  return {
    needs,
    suggestions: scoredPlayers,
  }
}

function buildRoomState(room) {
  const previewIndex = room.currentIndex >= 0 ? room.currentIndex : 0
  const nextNominee = playerMap.get(room.playerOrder[previewIndex]) ?? null
  const currentAuction = room.auction
    ? {
        ...room.auction,
        player: playerMap.get(room.auction.playerId) ?? null,
      }
    : null

  return {
    code: room.code,
    createdAt: room.createdAt,
    budgetCap: DEFAULT_BUDGET,
    playerPool: PLAYERS,
    sold: room.sold,
    unsold: room.unsold,
    paused: room.paused,
    currentIndex: room.currentIndex,
    nextNominee,
    queuePreview: room.playerOrder
      .slice(previewIndex, previewIndex + 8)
      .map((id) => playerMap.get(id))
      .filter(Boolean),
    owners: room.owners.map(getOwnerSummary),
    currentAuction,
    playerProgress: {
      completed: room.sold.length + room.unsold.length,
      total: room.playerOrder.length,
      remaining: room.playerOrder.length - (room.sold.length + room.unsold.length),
    },
    ai: room.owners.map((owner) => ({
      ownerId: owner.id,
      ownerName: owner.teamName,
      ...computeSuggestion(room, owner),
    })),
    version: room.version,
  }
}

function emitState(io, room) {
  room.version += 1
  io.to(room.code).emit('room-state', buildRoomState(room))
}

function clearAuctionTimer(room) {
  if (room.auction?.timeoutId) {
    clearTimeout(room.auction.timeoutId)
  }
  if (room.auction) {
    room.auction.timeoutId = null
  }
}

function scheduleAuctionDeadline(io, room, seconds) {
  clearAuctionTimer(room)
  if (!room.auction) return
  room.auction.endsAt = Date.now() + seconds * 1000
  room.auction.timeoutId = setTimeout(() => finalizeCurrentAuction(io, room), seconds * 1000)
}

function getNextUnsoldPlayer(room) {
  const nextId = room.playerOrder[room.currentIndex]
  return nextId ? playerMap.get(nextId) : null
}

function startCurrentPlayer(io, room) {
  if (room.paused) {
    return
  }

  const player = getNextUnsoldPlayer(room)
  if (!player) {
    room.auction = null
    emitState(io, room)
    return
  }

  room.auction = {
    playerId: player.id,
    currentBid: player.basePrice,
    highestBidderId: null,
    highestBidderName: null,
    extensions: 0,
    eventLog: [`${player.name} enters the stage at ${player.basePrice.toFixed(1)} cr.`],
    endsAt: null,
    timeoutId: null,
  }

  scheduleAuctionDeadline(io, room, BASE_COUNTDOWN_SECONDS)
  emitState(io, room)
}

function advanceToNextPlayer(io, room) {
  room.currentIndex += 1
  startCurrentPlayer(io, room)
}

function finalizeCurrentAuction(io, room) {
  if (!room.auction) {
    return
  }

  const { playerId, currentBid, highestBidderId } = room.auction
  const player = playerMap.get(playerId)
  clearAuctionTimer(room)

  if (!player) {
    room.auction = null
    emitState(io, room)
    return
  }

  if (highestBidderId) {
    const owner = room.owners.find((entry) => entry.id === highestBidderId)
    if (owner) {
      owner.budget -= currentBid
      owner.squad.push({
        ...player,
        price: currentBid,
      })
      room.sold.push({
        playerId,
        price: currentBid,
        ownerId: owner.id,
        ownerName: owner.teamName,
      })
    }
  } else {
    room.unsold.push({
      playerId,
      price: player.basePrice,
    })
  }

  room.auction = null
  emitState(io, room)

  setTimeout(() => {
    if (!room.paused) {
      advanceToNextPlayer(io, room)
    }
  }, 1600)
}

function assertAdmin(room, ownerId) {
  return room.adminId === ownerId
}

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size })
})

app.get('/players', (_req, res) => {
  res.json(PLAYERS)
})

app.get('/room-code', (_req, res) => {
  res.json({ code: generateCode() })
})

app.use(express.static(distDir))

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/socket.io')) {
    next()
    return
  }

  res.sendFile(path.join(distDir, 'index.html'))
})

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*',
  },
})

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomCode, ownerName, teamName, isAdmin }, callback = () => {}) => {
    const code = normalizeName(roomCode, generateCode()).toUpperCase()
    const room = getRoom(code)
    const owner = {
      id: socket.id,
      socketId: socket.id,
      name: normalizeName(ownerName, 'Owner'),
      teamName: normalizeName(teamName, `Team ${room.owners.length + 1}`),
      budget: DEFAULT_BUDGET,
      squad: [],
      room,
    }

    room.owners = room.owners.filter((entry) => entry.socketId !== socket.id)
    room.owners.push(owner)

    if (!room.adminId || isAdmin) {
      room.adminId = owner.id
    }

    socket.join(code)
    socket.data.roomCode = code
    socket.data.ownerId = owner.id
    emitState(io, room)
    callback({ ok: true, code, ownerId: owner.id, isAdmin: room.adminId === owner.id })
  })

  socket.on('request-state', ({ roomCode }) => {
    const room = rooms.get((roomCode ?? '').toUpperCase())
    if (room) {
      socket.emit('room-state', buildRoomState(room))
    }
  })

  socket.on('start-auction', ({ roomCode }, callback = () => {}) => {
    const room = rooms.get((roomCode ?? '').toUpperCase())
    if (!room) {
      callback({ ok: false, message: 'Room not found.' })
      return
    }
    if (!assertAdmin(room, socket.data.ownerId)) {
      callback({ ok: false, message: 'Only the admin can start the auction.' })
      return
    }
    if (room.currentIndex === -1) {
      room.currentIndex = 0
    }
    room.paused = false
    if (!room.auction) {
      startCurrentPlayer(io, room)
    } else {
      emitState(io, room)
    }
    callback({ ok: true, message: 'Auction started.' })
  })

  socket.on('place-bid', ({ roomCode, amount }, callback = () => {}) => {
    const room = rooms.get((roomCode ?? '').toUpperCase())
    if (!room || !room.auction || room.paused) {
      callback({ ok: false, message: 'Auction is not active.' })
      return
    }

    const owner = room.owners.find((entry) => entry.id === socket.data.ownerId)
    if (!owner) {
      callback({ ok: false, message: 'Owner not found.' })
      return
    }

    const numericAmount = Number(amount)
    if (Number.isNaN(numericAmount) || numericAmount <= room.auction.currentBid) {
      callback({ ok: false, message: 'Bid must exceed the current price.' })
      return
    }

    if (numericAmount > owner.budget) {
      callback({ ok: false, message: 'Insufficient purse for that bid.' })
      return
    }

    const remainingMs = room.auction.endsAt - Date.now()
    room.auction.currentBid = numericAmount
    room.auction.highestBidderId = owner.id
    room.auction.highestBidderName = owner.teamName
    room.auction.eventLog = [
      `${owner.teamName} bids ${numericAmount.toFixed(1)} cr.`,
      ...room.auction.eventLog.slice(0, 4),
    ]

    const isSnipingBid = remainingMs <= ANTI_SNIPING_THRESHOLD_SECONDS * 1000
    if (isSnipingBid) {
      room.auction.extensions += 1
    }

    scheduleAuctionDeadline(
      io,
      room,
      isSnipingBid ? ANTI_SNIPING_EXTENSION_SECONDS : RESET_COUNTDOWN_SECONDS,
    )

    emitState(io, room)
    callback({
      ok: true,
      message: isSnipingBid ? 'Bid accepted. Anti-sniping extension applied.' : 'Bid accepted.',
    })
  })

  socket.on('pause-auction', ({ roomCode }, callback = () => {}) => {
    const room = rooms.get((roomCode ?? '').toUpperCase())
    if (!room) {
      callback({ ok: false, message: 'Room not found.' })
      return
    }
    if (!assertAdmin(room, socket.data.ownerId)) {
      callback({ ok: false, message: 'Only the admin can pause the auction.' })
      return
    }
    room.paused = true
    clearAuctionTimer(room)
    if (room.auction) {
      room.auction.endsAt = Date.now()
    }
    emitState(io, room)
    callback({ ok: true, message: 'Auction paused.' })
  })

  socket.on('resume-auction', ({ roomCode }, callback = () => {}) => {
    const room = rooms.get((roomCode ?? '').toUpperCase())
    if (!room) {
      callback({ ok: false, message: 'Room not found.' })
      return
    }
    if (!assertAdmin(room, socket.data.ownerId)) {
      callback({ ok: false, message: 'Only the admin can resume the auction.' })
      return
    }
    room.paused = false
    if (room.auction) {
      scheduleAuctionDeadline(io, room, RESET_COUNTDOWN_SECONDS)
      emitState(io, room)
    } else if (room.currentIndex >= 0) {
      startCurrentPlayer(io, room)
    }
    callback({ ok: true, message: 'Auction resumed.' })
  })

  socket.on('skip-player', ({ roomCode }, callback = () => {}) => {
    const room = rooms.get((roomCode ?? '').toUpperCase())
    if (!room) {
      callback({ ok: false, message: 'Room not found.' })
      return
    }
    if (!assertAdmin(room, socket.data.ownerId)) {
      callback({ ok: false, message: 'Only the admin can skip a player.' })
      return
    }
    if (room.auction) {
      const player = playerMap.get(room.auction.playerId)
      if (player) {
        room.unsold.push({ playerId: player.id, price: player.basePrice })
      }
      clearAuctionTimer(room)
      room.auction = null
    }
    emitState(io, room)
    setTimeout(() => {
      if (!room.paused) {
        advanceToNextPlayer(io, room)
      }
    }, 700)
    callback({ ok: true, message: 'Player skipped.' })
  })

  socket.on('disconnect', () => {
    const code = socket.data.roomCode
    if (!code) return

    const room = rooms.get(code)
    if (!room) return

    room.owners = room.owners.filter((entry) => entry.socketId !== socket.id)

    if (room.adminId === socket.id) {
      room.adminId = room.owners[0]?.id ?? null
    }

    if (room.owners.length === 0) {
      clearAuctionTimer(room)
      rooms.delete(code)
      return
    }

    emitState(io, room)
  })
})

server.listen(PORT, () => {
  console.log(`Auction server listening on http://localhost:${PORT}`)
})
