import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { io } from 'socket.io-client'
import './App.css'

const socket = io({
  autoConnect: false,
})
const MotionSection = motion.section
const MotionArticle = motion.article
const MotionDiv = motion.div

const formatCrores = (value) => `${Number(value ?? 0).toFixed(1)} cr`

const buildRoleLabel = (counts) =>
  `Bat ${counts?.batter ?? 0} | Bowl ${counts?.bowler ?? 0} | AR ${counts?.allRounder ?? 0} | WK ${counts?.keeper ?? 0}`

const getStatusTone = (message) => {
  if (!message) return 'neutral'
  if (message.toLowerCase().includes('accepted')) return 'success'
  if (message.toLowerCase().includes('extension')) return 'warning'
  if (message.toLowerCase().includes('insufficient') || message.toLowerCase().includes('must')) return 'danger'
  return 'neutral'
}

function App() {
  const [connected, setConnected] = useState(false)
  const [roomCode, setRoomCode] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [teamName, setTeamName] = useState('')
  const [wantsAdmin, setWantsAdmin] = useState(true)
  const [session, setSession] = useState(null)
  const [roomState, setRoomState] = useState(null)
  const [clock, setClock] = useState(0)
  const [bidAmount, setBidAmount] = useState('')
  const [statusMessage, setStatusMessage] = useState('Create a room or join one with friends.')
  const statusTimeout = useRef(null)

  const currentAuction = roomState?.currentAuction ?? null
  const currentOwner = roomState?.owners?.find((owner) => owner.id === session?.ownerId) ?? null
  const aiForOwner = roomState?.ai?.find((entry) => entry.ownerId === session?.ownerId) ?? null
  const stagePlayer = currentAuction?.player ?? roomState?.nextNominee ?? null
  const isAdmin = Boolean(currentOwner?.isAdmin ?? session?.isAdmin)
  const countdown = currentAuction?.endsAt
    ? Math.max(0, Math.ceil((currentAuction.endsAt - clock) / 1000))
    : 0
  const canBid =
    Boolean(currentAuction) &&
    Boolean(currentOwner) &&
    !roomState?.paused &&
    currentOwner.budget > currentAuction.currentBid

  useEffect(() => {
    socket.connect()

    socket.on('connect', () => {
      setConnected(true)
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on('connect_error', () => {
      setConnected(false)
      setStatusMessage('Cannot reach the auction server. Refresh after the backend is live.')
    })

    socket.on('room-state', (nextState) => {
      setRoomState(nextState)
      if (nextState.currentAuction) {
        setBidAmount((nextState.currentAuction.currentBid + 1).toFixed(1))
      }
    })

    return () => {
      socket.off('connect')
      socket.off('disconnect')
      socket.off('connect_error')
      socket.off('room-state')
      socket.disconnect()
    }
  }, [])

  useEffect(() => {
    const intervalId = setInterval(() => setClock(Date.now()), 250)
    return () => clearInterval(intervalId)
  }, [])

  useEffect(() => {
    return () => {
      if (statusTimeout.current) {
        clearTimeout(statusTimeout.current)
      }
    }
  }, [])

  const announce = (message) => {
    setStatusMessage(message)
    if (statusTimeout.current) {
      clearTimeout(statusTimeout.current)
    }
    statusTimeout.current = setTimeout(() => {
      setStatusMessage('Live room synced.')
    }, 3200)
  }

  const createRoomCode = async () => {
    const response = await fetch('/room-code')
    const data = await response.json()
    setRoomCode(data.code)
  }

  const joinRoom = () => {
    if (!roomCode.trim() || !ownerName.trim() || !teamName.trim()) {
      announce('Room code, owner name, and team name are required.')
      return
    }

    socket.emit(
      'join-room',
      {
        roomCode,
        ownerName,
        teamName,
        isAdmin: wantsAdmin,
      },
      (response) => {
        if (!response?.ok) {
          announce('Unable to join room.')
          return
        }

        setSession({
          ownerId: response.ownerId,
          code: response.code,
          isAdmin: response.isAdmin,
        })
        setRoomCode(response.code)
        socket.emit('request-state', { roomCode: response.code })
        announce(`Joined room ${response.code}.`)
      },
    )
  }

  const sendAdminAction = (eventName) => {
    if (!session?.code) return
    socket.emit(eventName, { roomCode: session.code }, (response) => {
      announce(response?.message ?? 'Room updated.')
    })
  }

  const placeBid = (amount) => {
    if (!session?.code) return
    socket.emit(
      'place-bid',
      {
        roomCode: session.code,
        amount: Number(amount),
      },
      (response) => {
        announce(response?.message ?? 'Bid update received.')
      },
    )
  }

  const analytics = currentOwner
    ? {
        remaining: currentOwner.budget,
        spent: currentOwner.spent,
        avgSpend: currentOwner.squadSize ? currentOwner.spent / currentOwner.squadSize : 0,
        maxBid: currentOwner.budget,
      }
    : null

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      {!session ? (
        <main className="lobby-shell">
          <MotionSection
            className="lobby-card glass-panel"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="eyebrow-row">
              <span className="pill">{connected ? 'Socket Live' : 'Connecting'}</span>
              <span className="pill accent">IPL Auction Arena</span>
            </div>

            <h1>Real-time fantasy auction room for private IPL-style bidding.</h1>
            <p className="lead">
              Invite friends with a room code, run a live player auction, and track purse, squads,
              and AI scouting recommendations as the room syncs in real time.
            </p>

            <div className="lobby-grid">
              <label>
                Room code
                <div className="inline-field">
                  <input
                    value={roomCode}
                    onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                    placeholder="AB12CD"
                  />
                  <button type="button" className="ghost-button" onClick={createRoomCode}>
                    Generate
                  </button>
                </div>
              </label>

              <label>
                Owner name
                <input
                  value={ownerName}
                  onChange={(event) => setOwnerName(event.target.value)}
                  placeholder="Aarav"
                />
              </label>

              <label>
                Team name
                <input
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                  placeholder="Mumbai Mavericks"
                />
              </label>

              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={wantsAdmin}
                  onChange={(event) => setWantsAdmin(event.target.checked)}
                />
                Join as admin controller
              </label>
            </div>

            <div className="cta-row">
              <button type="button" className="primary-button" onClick={joinRoom}>
                Enter auction room
              </button>
              <span className={`status-chip ${getStatusTone(statusMessage)}`}>{statusMessage}</span>
            </div>
          </MotionSection>
        </main>
      ) : (
        <main className="dashboard-shell">
          <section className="hero-stage glass-panel">
            <div className="hero-header">
              <div>
                <div className="eyebrow-row">
                  <span className="pill">Room {session.code}</span>
                  <span className="pill accent">{roomState?.playerProgress?.remaining ?? 0} players left</span>
                </div>
                <h1>{stagePlayer?.name ?? 'Auction ready'}</h1>
                <p className="lead">
                  {stagePlayer
                    ? `${stagePlayer.role} | ${stagePlayer.team} | Base ${formatCrores(stagePlayer.basePrice)}`
                    : 'Admin can start the live auction when all owners have joined.'}
                </p>
              </div>

              <div className="hero-summary">
                <div className={`timer-orb ${countdown <= 5 ? 'danger' : ''}`}>
                  <span>{countdown}s</span>
                  <small>{roomState?.paused ? 'Paused' : 'On the clock'}</small>
                </div>
                <div className="status-stack">
                  <div className="metric-card small">
                    <span>Highest bid</span>
                    <strong>{formatCrores(currentAuction?.currentBid ?? 0)}</strong>
                  </div>
                  <div className="metric-card small">
                    <span>Leading team</span>
                    <strong>{currentAuction?.highestBidderName ?? 'No bids yet'}</strong>
                  </div>
                </div>
              </div>
            </div>

            <div className="stage-grid">
              <AnimatePresence mode="wait">
                <MotionArticle
                  key={currentAuction?.playerId ?? 'empty-stage'}
                  className="player-stage"
                  initial={{ opacity: 0, x: 28 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -28 }}
                  transition={{ duration: 0.35 }}
                >
                  {stagePlayer ? (
                    <>
                      <div className="player-badge-row">
                        <span className="role-chip">{stagePlayer.role}</span>
                        <span className="role-chip">{stagePlayer.rating} rating</span>
                        <span className="role-chip alert">
                          {currentAuction?.extensions ?? 0} anti-snipe extensions
                        </span>
                      </div>

                      <div className="stats-grid">
                        <div className="metric-card">
                          <span>Strike rate</span>
                          <strong>{stagePlayer.strikeRate}</strong>
                        </div>
                        <div className="metric-card">
                          <span>Average</span>
                          <strong>{stagePlayer.average}</strong>
                        </div>
                        <div className="metric-card">
                          <span>Base price</span>
                          <strong>{formatCrores(stagePlayer.basePrice)}</strong>
                        </div>
                        <div className="metric-card">
                          <span>Current call</span>
                          <strong>{formatCrores(currentAuction?.currentBid ?? stagePlayer.basePrice)}</strong>
                        </div>
                      </div>

                      <div className="tag-row">
                        {stagePlayer.tags.map((tag) => (
                          <span key={tag} className="tag-pill">
                            {tag}
                          </span>
                        ))}
                      </div>

                      <div className="bid-box glass-subpanel">
                        <div>
                          <h2>Place live bid</h2>
                          <p>
                            Purse available: <strong>{formatCrores(currentOwner?.budget ?? 0)}</strong>
                          </p>
                        </div>

                        <div className="bid-controls">
                          <input
                            type="number"
                            min={currentAuction.currentBid + 0.5}
                            step="0.5"
                            value={bidAmount}
                            onChange={(event) => setBidAmount(event.target.value)}
                            disabled={!canBid}
                          />
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={!canBid}
                            onClick={() =>
                              setBidAmount((currentAuction.currentBid + 1).toFixed(1))
                            }
                          >
                            +1 cr
                          </button>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={!canBid}
                            onClick={() => placeBid(bidAmount)}
                          >
                            Bid now
                          </button>
                        </div>

                        <p className="subtle-note">
                          {currentAuction
                            ? 'Every fresh bid resets the timer. Bids in the last 5 seconds trigger a 10-second anti-sniping extension.'
                            : 'Previewing the next nominee. Press Start auction to open live bidding for this player.'}
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="empty-stage">
                      <h2>No player on stage</h2>
                      <p>The room is waiting for the auctioneer to begin or move to the next player.</p>
                    </div>
                  )}
                </MotionArticle>
              </AnimatePresence>

              <aside className="side-stack">
                <div className="glass-subpanel">
                  <div className="panel-header">
                    <h2>Admin controls</h2>
                    <span className="pill">{isAdmin ? 'You control the room' : 'View only'}</span>
                  </div>

                  <div className="admin-grid">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!isAdmin}
                      onClick={() => sendAdminAction('start-auction')}
                    >
                      Start auction
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!isAdmin}
                      onClick={() => sendAdminAction('skip-player')}
                    >
                      Skip player
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!isAdmin}
                      onClick={() => sendAdminAction(roomState?.paused ? 'resume-auction' : 'pause-auction')}
                    >
                      {roomState?.paused ? 'Resume' : 'Pause'}
                    </button>
                  </div>
                </div>

                <div className="glass-subpanel">
                  <div className="panel-header">
                    <h2>Player pool</h2>
                    <span className="pill accent">
                      {roomState?.playerProgress?.total ?? 0} listed
                    </span>
                  </div>

                  <div className="suggestion-list">
                    {roomState?.queuePreview?.map((player) => (
                      <div key={player.id} className="suggestion-card">
                        <strong>{player.name}</strong>
                        <span>
                          {player.role} | {formatCrores(player.basePrice)}
                        </span>
                        <p>
                          {player.team} | SR {player.strikeRate} | Avg {player.average}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="glass-subpanel">
                  <div className="panel-header">
                    <h2>AI squad coach</h2>
                    <span className="pill accent">{aiForOwner?.needs?.length ?? 0} role gaps</span>
                  </div>

                  <div className="suggestion-list">
                    {aiForOwner?.suggestions?.map((item) => (
                      <MotionDiv
                        key={item.playerId}
                        className="suggestion-card"
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                      >
                        <strong>{item.name}</strong>
                        <span>
                          {item.role} | {formatCrores(item.price)}
                        </span>
                        <p>{item.rationale}</p>
                      </MotionDiv>
                    ))}
                    {!aiForOwner?.suggestions?.length && (
                      <p className="subtle-note">No value suggestions available within your current purse.</p>
                    )}
                  </div>
                </div>
              </aside>
            </div>
          </section>

          <section className="owners-strip">
            {roomState?.owners?.map((owner, index) => (
              <MotionArticle
                key={owner.id}
                className={`owner-card glass-panel ${owner.id === currentAuction?.highestBidderId ? 'leading' : ''}`}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 * index }}
              >
                <div className="panel-header">
                  <div>
                    <h2>{owner.teamName}</h2>
                    <p>{owner.name}</p>
                  </div>
                  <span className="pill">{owner.isAdmin ? 'Admin' : 'Owner'}</span>
                </div>

                <div className="owner-stats">
                  <div>
                    <span>Purse left</span>
                    <strong>{formatCrores(owner.budget)}</strong>
                  </div>
                  <div>
                    <span>Spent</span>
                    <strong>{formatCrores(owner.spent)}</strong>
                  </div>
                  <div>
                    <span>Squad size</span>
                    <strong>{owner.squadSize}</strong>
                  </div>
                </div>

                <p className="subtle-note">{buildRoleLabel(owner.roleCounts)}</p>
              </MotionArticle>
            ))}
          </section>

          <section className="bottom-grid">
            <div className="glass-panel">
              <div className="panel-header">
                <h2>Budget analytics</h2>
                <span className={`status-chip ${getStatusTone(statusMessage)}`}>{statusMessage}</span>
              </div>

              <div className="stats-grid">
                <div className="metric-card">
                  <span>Remaining purse</span>
                  <strong>{formatCrores(analytics?.remaining ?? 0)}</strong>
                </div>
                <div className="metric-card">
                  <span>Total spent</span>
                  <strong>{formatCrores(analytics?.spent ?? 0)}</strong>
                </div>
                <div className="metric-card">
                  <span>Average buy</span>
                  <strong>{formatCrores(analytics?.avgSpend ?? 0)}</strong>
                </div>
                <div className="metric-card">
                  <span>Max affordable bid</span>
                  <strong>{formatCrores(analytics?.maxBid ?? 0)}</strong>
                </div>
              </div>

              <div className="sales-grid">
                <div>
                  <h3>Sold ledger</h3>
                  <div className="ledger-list">
                    {roomState?.sold?.slice(-6).reverse().map((sale) => (
                      <div key={`${sale.playerId}-${sale.ownerId}`} className="ledger-item">
                        <span>
                          {roomState.playerPool.find((player) => player.id === sale.playerId)?.name ??
                            sale.playerId}
                        </span>
                        <strong>
                          {sale.ownerName} | {formatCrores(sale.price)}
                        </strong>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h3>Unsold</h3>
                  <div className="ledger-list">
                    {roomState?.unsold?.slice(-6).reverse().map((item) => (
                      <div key={`${item.playerId}-unsold`} className="ledger-item">
                        <span>
                          {roomState.playerPool.find((player) => player.id === item.playerId)?.name ??
                            item.playerId}
                        </span>
                        <strong>Base {formatCrores(item.price)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="glass-panel">
              <div className="panel-header">
                <h2>Team squads</h2>
                <span className="pill accent">{roomState?.owners?.length ?? 0} live owners</span>
              </div>

              <div className="squad-columns">
                {roomState?.owners?.map((owner) => (
                  <div key={owner.id} className="squad-column">
                    <div className="squad-head">
                      <strong>{owner.teamName}</strong>
                      <span>{formatCrores(owner.budget)} left</span>
                    </div>
                    <div className="squad-list">
                      {owner.squad.map((player) => (
                        <div key={`${owner.id}-${player.id}`} className="squad-item">
                          <span>{player.name}</span>
                          <strong>{formatCrores(player.price)}</strong>
                        </div>
                      ))}
                      {!owner.squad.length && <p className="subtle-note">No signings yet.</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      )}
    </div>
  )
}

export default App
