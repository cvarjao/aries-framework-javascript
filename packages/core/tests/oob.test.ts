/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { SubjectMessage } from '../../../tests/transport/SubjectInboundTransport'
import type { CredentialRecord, CredentialOfferTemplate } from '../src/modules/credentials'
import type { DidCommV1Service } from '../src/modules/dids'
import type { AgentMessageReceivedEvent } from '@aries-framework/core'

import { Subject } from 'rxjs'

import { SubjectInboundTransport } from '../../../tests/transport/SubjectInboundTransport'
import { SubjectOutboundTransport } from '../../../tests/transport/SubjectOutboundTransport'
import { Agent } from '../src/agent/Agent'
import { KeyType } from '../src/crypto'
import { DidExchangeState, HandshakeProtocol } from '../src/modules/connections'
import { DidKey, Key } from '../src/modules/dids'
import { OutOfBandDidCommService } from '../src/modules/oob/domain/OutOfBandDidCommService'
import { OutOfBandRole } from '../src/modules/oob/domain/OutOfBandRole'
import { OutOfBandState } from '../src/modules/oob/domain/OutOfBandState'
import { OutOfBandInvitation } from '../src/modules/oob/messages'
import { sleep } from '../src/utils/sleep'

import { TestMessage } from './TestMessage'
import { getBaseConfig, prepareForIssuance } from './helpers'

import {
  AgentEventTypes,
  AriesFrameworkError,
  AutoAcceptCredential,
  CredentialPreview,
  CredentialState,
} from '@aries-framework/core' // Maybe it's not bad to import from package?

const faberConfig = getBaseConfig('Faber Agent OOB', {
  endpoints: ['rxjs:faber'],
})
const aliceConfig = getBaseConfig('Alice Agent OOB', {
  endpoints: ['rxjs:alice'],
})

describe('out of band', () => {
  const makeConnectionConfig = {
    goal: 'To make a connection',
    goalCode: 'p2p-messaging',
    label: 'Faber College',
  }

  const issueCredentialConfig = {
    goal: 'To issue a credential',
    goalCode: 'issue-vc',
    label: 'Faber College',
    handshake: false,
  }

  const receiveMessageConfig = {
    autoAcceptConnection: false,
  }

  let faberAgent: Agent
  let aliceAgent: Agent
  let credentialTemplate: CredentialOfferTemplate

  beforeAll(async () => {
    const faberMessages = new Subject<SubjectMessage>()
    const aliceMessages = new Subject<SubjectMessage>()
    const subjectMap = {
      'rxjs:faber': faberMessages,
      'rxjs:alice': aliceMessages,
    }

    faberAgent = new Agent(faberConfig.config, faberConfig.agentDependencies)
    faberAgent.registerInboundTransport(new SubjectInboundTransport(faberMessages))
    faberAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await faberAgent.initialize()

    aliceAgent = new Agent(aliceConfig.config, aliceConfig.agentDependencies)
    aliceAgent.registerInboundTransport(new SubjectInboundTransport(aliceMessages))
    aliceAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await aliceAgent.initialize()

    const { definition } = await prepareForIssuance(faberAgent, ['name', 'age', 'profile_picture', 'x-ray'])

    credentialTemplate = {
      credentialDefinitionId: definition.id,
      preview: CredentialPreview.fromRecord({
        name: 'name',
        age: 'age',
        profile_picture: 'profile_picture',
        'x-ray': 'x-ray',
      }),
      autoAcceptCredential: AutoAcceptCredential.Never,
    }
  })

  afterAll(async () => {
    await faberAgent.shutdown()
    await faberAgent.wallet.delete()
    await aliceAgent.shutdown()
    await aliceAgent.wallet.delete()
  })

  afterEach(async () => {
    const credentials = await aliceAgent.credentials.getAll()
    for (const credential of credentials) {
      await aliceAgent.credentials.deleteById(credential.id)
    }

    const connections = await faberAgent.connections.getAll()
    for (const connection of connections) {
      await faberAgent.connections.deleteById(connection.id)
    }

    jest.resetAllMocks()
  })

  describe('createMessage', () => {
    test('throw error when there is no handshake or message', async () => {
      await expect(faberAgent.oob.createInvitation({ label: 'test-connection', handshake: false })).rejects.toEqual(
        new AriesFrameworkError(
          'One or both of handshake_protocols and requests~attach MUST be included in the message.'
        )
      )
    })

    test('create OOB record', async () => {
      const outOfBandRecord = await faberAgent.oob.createInvitation(makeConnectionConfig)
      // expect contains services

      expect(outOfBandRecord.autoAcceptConnection).toBe(true)
      expect(outOfBandRecord.role).toBe(OutOfBandRole.Sender)
      expect(outOfBandRecord.state).toBe(OutOfBandState.AwaitResponse)
      expect(outOfBandRecord.reusable).toBe(false)
      expect(outOfBandRecord.outOfBandInvitation.goal).toBe('To make a connection')
      expect(outOfBandRecord.outOfBandInvitation.goalCode).toBe('p2p-messaging')
      expect(outOfBandRecord.outOfBandInvitation.label).toBe('Faber College')
    })

    test('create OOB message only with handshake', async () => {
      const { outOfBandInvitation } = await faberAgent.oob.createInvitation(makeConnectionConfig)

      // expect supported handshake protocols
      expect(outOfBandInvitation.handshakeProtocols).toContain(HandshakeProtocol.DidExchange)
      expect(outOfBandInvitation.getRequests()).toBeUndefined()

      // expect contains services
      const [service] = outOfBandInvitation.services as OutOfBandDidCommService[]
      expect(service).toMatchObject(
        new OutOfBandDidCommService({
          id: expect.any(String),
          serviceEndpoint: 'rxjs:faber',
          recipientKeys: [expect.stringContaining('did:key:')],
          routingKeys: [],
        })
      )
    })

    test('create OOB message only with requests', async () => {
      const { offerMessage } = await faberAgent.credentials.createOutOfBandOffer(credentialTemplate)
      const { outOfBandInvitation } = await faberAgent.oob.createInvitation({
        label: 'test-connection',
        handshake: false,
        messages: [offerMessage],
      })

      // expect supported handshake protocols
      expect(outOfBandInvitation.handshakeProtocols).toBeUndefined()
      expect(outOfBandInvitation.getRequests()).toHaveLength(1)

      // expect contains services
      const [service] = outOfBandInvitation.services
      expect(service).toMatchObject(
        new OutOfBandDidCommService({
          id: expect.any(String),
          serviceEndpoint: 'rxjs:faber',
          recipientKeys: [expect.stringContaining('did:key:')],
          routingKeys: [],
        })
      )
    })

    test('create OOB message with both handshake and requests', async () => {
      const { offerMessage } = await faberAgent.credentials.createOutOfBandOffer(credentialTemplate)
      const { outOfBandInvitation } = await faberAgent.oob.createInvitation({
        label: 'test-connection',
        handshakeProtocols: [HandshakeProtocol.Connections],
        messages: [offerMessage],
      })

      // expect supported handshake protocols
      expect(outOfBandInvitation.handshakeProtocols).toContain(HandshakeProtocol.Connections)
      expect(outOfBandInvitation.getRequests()).toHaveLength(1)

      // expect contains services
      const [service] = outOfBandInvitation.services as OutOfBandDidCommService[]
      expect(service).toMatchObject(
        new OutOfBandDidCommService({
          id: expect.any(String),
          serviceEndpoint: 'rxjs:faber',
          recipientKeys: [expect.stringMatching('did:key:')],
          routingKeys: [],
        })
      )
    })
  })

  describe('receiveMessage', () => {
    test('receive OOB connection invitation', async () => {
      const outOfBandRecord = await faberAgent.oob.createInvitation(makeConnectionConfig)
      const { outOfBandInvitation } = outOfBandRecord

      const { outOfBandRecord: receivedOutOfBandRecord, connectionRecord } = await aliceAgent.oob.receiveInvitation(
        outOfBandInvitation,
        {
          autoAcceptInvitation: false,
          autoAcceptConnection: false,
        }
      )

      expect(connectionRecord).not.toBeDefined()
      expect(receivedOutOfBandRecord.role).toBe(OutOfBandRole.Receiver)
      expect(receivedOutOfBandRecord.state).toBe(OutOfBandState.Initial)
      expect(receivedOutOfBandRecord.outOfBandInvitation).toEqual(outOfBandInvitation)
    })

    test(`make a connection with ${HandshakeProtocol.DidExchange} on OOB invitation encoded in URL`, async () => {
      const outOfBandRecord = await faberAgent.oob.createInvitation(makeConnectionConfig)
      const { outOfBandInvitation } = outOfBandRecord
      const urlMessage = outOfBandInvitation.toUrl({ domain: 'http://example.com' })

      // eslint-disable-next-line prefer-const
      let { outOfBandRecord: receivedOutOfBandRecord, connectionRecord: aliceFaberConnection } =
        await aliceAgent.oob.receiveInvitationFromUrl(urlMessage)
      expect(receivedOutOfBandRecord.state).toBe(OutOfBandState.PrepareResponse)

      aliceFaberConnection = await aliceAgent.connections.returnWhenIsConnected(aliceFaberConnection!.id)
      expect(aliceFaberConnection.state).toBe(DidExchangeState.Completed)

      let faberAliceConnection = await faberAgent.connections.findByOutOfBandId(outOfBandRecord!.id)
      faberAliceConnection = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection!.id)
      expect(faberAliceConnection?.state).toBe(DidExchangeState.Completed)

      expect(aliceFaberConnection).toBeConnectedWith(faberAliceConnection!)
      expect(faberAliceConnection).toBeConnectedWith(aliceFaberConnection)
    })

    test(`make a connection with ${HandshakeProtocol.Connections} based on OOB invitation encoded in URL`, async () => {
      const outOfBandRecord = await faberAgent.oob.createInvitation({
        ...makeConnectionConfig,
        handshakeProtocols: [HandshakeProtocol.Connections],
      })
      const { outOfBandInvitation } = outOfBandRecord
      const urlMessage = outOfBandInvitation.toUrl({ domain: 'http://example.com' })

      let { connectionRecord: aliceFaberConnection } = await aliceAgent.oob.receiveInvitationFromUrl(urlMessage)

      aliceFaberConnection = await aliceAgent.connections.returnWhenIsConnected(aliceFaberConnection!.id)
      expect(aliceFaberConnection.state).toBe(DidExchangeState.Completed)

      let faberAliceConnection = await faberAgent.connections.findByOutOfBandId(outOfBandRecord!.id)
      faberAliceConnection = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection!.id)
      expect(faberAliceConnection.state).toBe(DidExchangeState.Completed)

      expect(aliceFaberConnection).toBeConnectedWith(faberAliceConnection)
      expect(faberAliceConnection).toBeConnectedWith(aliceFaberConnection)
    })

    test('make a connection based on old connection invitation encoded in URL', async () => {
      const { outOfBandRecord, invitation } = await faberAgent.oob.createLegacyInvitation({
        ...makeConnectionConfig,
        handshakeProtocols: [HandshakeProtocol.Connections],
      })
      const urlMessage = invitation.toUrl({ domain: 'http://example.com' })

      let { connectionRecord: aliceFaberConnection } = await aliceAgent.oob.receiveInvitationFromUrl(urlMessage)

      aliceFaberConnection = await aliceAgent.connections.returnWhenIsConnected(aliceFaberConnection!.id)
      let faberAliceConnection = await faberAgent.connections.findByOutOfBandId(outOfBandRecord.id)
      faberAliceConnection = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection!.id)

      expect(aliceFaberConnection.state).toBe(DidExchangeState.Completed)
      expect(faberAliceConnection.state).toBe(DidExchangeState.Completed)

      expect(faberAliceConnection).toBeConnectedWith(aliceFaberConnection)
      expect(aliceFaberConnection).toBeConnectedWith(faberAliceConnection)
    })

    test('process credential offer requests based on OOB message', async () => {
      const { offerMessage } = await faberAgent.credentials.createOutOfBandOffer(credentialTemplate)
      const { outOfBandInvitation } = await faberAgent.oob.createInvitation({
        ...issueCredentialConfig,
        messages: [offerMessage],
      })

      const urlMessage = outOfBandInvitation.toUrl({ domain: 'http://example.com' })

      await aliceAgent.oob.receiveInvitationFromUrl(urlMessage, receiveMessageConfig)

      let credentials: CredentialRecord[] = []
      while (credentials.length < 1) {
        credentials = await aliceAgent.credentials.getAll()
        await sleep(100)
      }

      expect(credentials).toHaveLength(1)
      const [credential] = credentials
      expect(credential.state).toBe(CredentialState.OfferReceived)
    })

    test('do not process requests when a connection is not ready', async () => {
      const eventListener = jest.fn()
      aliceAgent.events.on<AgentMessageReceivedEvent>(AgentEventTypes.AgentMessageReceived, eventListener)

      const { offerMessage } = await faberAgent.credentials.createOutOfBandOffer(credentialTemplate)
      const { outOfBandInvitation } = await faberAgent.oob.createInvitation({
        ...makeConnectionConfig,
        messages: [offerMessage],
      })

      // First, we crate a connection but we won't accept it, therefore it won't be ready
      await aliceAgent.oob.receiveInvitation(outOfBandInvitation, { autoAcceptConnection: false })

      // Event should not be emitted because an agent must wait until the connection is ready
      expect(eventListener).toHaveBeenCalledTimes(0)

      aliceAgent.events.off<AgentMessageReceivedEvent>(AgentEventTypes.AgentMessageReceived, eventListener)
    })

    test('make a connection based on OOB invitation and process requests after the acceptation', async () => {
      const { offerMessage } = await faberAgent.credentials.createOutOfBandOffer(credentialTemplate)
      const outOfBandRecord = await faberAgent.oob.createInvitation({
        ...makeConnectionConfig,
        messages: [offerMessage],
      })
      const { outOfBandInvitation } = outOfBandRecord

      // First, we crate a connection but we won't accept it, therefore it won't be ready
      const { outOfBandRecord: aliceFaberOutOfBandRecord } = await aliceAgent.oob.receiveInvitation(
        outOfBandInvitation,
        {
          autoAcceptInvitation: false,
          autoAcceptConnection: false,
        }
      )

      // Accept connection invitation
      let { connectionRecord: aliceFaberConnection } = await aliceAgent.oob.acceptInvitation(
        aliceFaberOutOfBandRecord,
        {
          label: 'alice',
          autoAcceptConnection: true,
        }
      )

      // Wait until connection is ready
      aliceFaberConnection = await aliceAgent.connections.returnWhenIsConnected(aliceFaberConnection!.id)

      let faberAliceConnection = await faberAgent.connections.findByOutOfBandId(outOfBandRecord!.id)
      faberAliceConnection = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection!.id)
      expect(faberAliceConnection).toBeConnectedWith(aliceFaberConnection)
      expect(aliceFaberConnection).toBeConnectedWith(faberAliceConnection)

      // The credential should be processed when connection is made. It asynchronous so it can take a moment.
      let credentials: CredentialRecord[] = []
      while (credentials.length < 1) {
        credentials = await aliceAgent.credentials.getAll()
        await sleep(100)
      }

      expect(credentials).toHaveLength(1)
      const [credential] = credentials
      expect(credential.state).toBe(CredentialState.OfferReceived)
    })

    test('do not create a new connection when connection exists', async () => {
      const outOfBandRecord = await faberAgent.oob.createInvitation(makeConnectionConfig)
      const { outOfBandInvitation } = outOfBandRecord

      let { connectionRecord: firstAliceFaberConnection } = await aliceAgent.oob.receiveInvitation(outOfBandInvitation)
      firstAliceFaberConnection = await aliceAgent.connections.returnWhenIsConnected(firstAliceFaberConnection!.id)

      // To simulate the usage of the same connection we set up the same service as it is in
      // the existing faber connection to the out-of-band message services attribute.
      const theirDidDocument = await aliceAgent.dids.resolveDidDocument(firstAliceFaberConnection.theirDid!)
      const didDocumentService = theirDidDocument.service[0] as DidCommV1Service

      // Convert did-communication service into an out of band service
      // Maybe extract this into a util in the future
      const oobService = new OutOfBandDidCommService({
        id: didDocumentService.id,
        serviceEndpoint: didDocumentService.serviceEndpoint,
        recipientKeys: didDocumentService.recipientKeys.map(
          (keyId) =>
            new DidKey(
              Key.fromPublicKeyBase58(theirDidDocument.dereferenceKey(keyId).publicKeyBase58!, KeyType.Ed25519)
            ).did
        ),
      })
      outOfBandInvitation.services = [oobService]

      const { connectionRecord: secondAliceFaberConnection } = await aliceAgent.oob.receiveInvitation(
        outOfBandInvitation,
        { reuseConnection: true }
      )

      await aliceAgent.connections.returnWhenIsConnected(secondAliceFaberConnection!.id)

      let faberAliceConnection = await faberAgent.connections.findByOutOfBandId(outOfBandRecord!.id)
      faberAliceConnection = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection!.id)
      await faberAgent.connections.returnWhenIsConnected(faberAliceConnection!.id)

      expect(firstAliceFaberConnection.id).toEqual(secondAliceFaberConnection?.id)
    })

    test.skip('do not create a new connection when connection exists and multiuse is false', async () => {
      const outOfBandRecord = await faberAgent.oob.createInvitation({
        ...makeConnectionConfig,
        multiUseInvitation: false,
      })
      const { outOfBandInvitation } = outOfBandRecord

      let { connectionRecord: firstAliceFaberConnection } = await aliceAgent.oob.receiveInvitation(outOfBandInvitation)
      firstAliceFaberConnection = await aliceAgent.connections.returnWhenIsConnected(firstAliceFaberConnection!.id)

      await aliceAgent.oob.receiveInvitation(outOfBandInvitation)

      // TODO Somehow check agents throws an error or sends problem report

      let faberAliceConnection = await faberAgent.connections.findByOutOfBandId(outOfBandRecord!.id)
      faberAliceConnection = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection!.id)

      const faberConnections = await faberAgent.connections.getAll()
      expect(faberConnections).toHaveLength(1)
      expect(faberAliceConnection.state).toBe(DidExchangeState.Completed)
      expect(firstAliceFaberConnection.state).toBe(DidExchangeState.Completed)
    })

    test('create a new connection when connection exists and reuse is false', async () => {
      const { outOfBandInvitation } = await faberAgent.oob.createInvitation({
        ...makeConnectionConfig,
        handshakeProtocols: [HandshakeProtocol.DidExchange],
        multiUseInvitation: true,
      })
      let { connectionRecord: firstAliceFaberConnection } = await aliceAgent.oob.receiveInvitation(outOfBandInvitation)
      firstAliceFaberConnection = await aliceAgent.connections.returnWhenIsConnected(firstAliceFaberConnection!.id)

      let { connectionRecord: secondAliceFaberConnection } = await aliceAgent.oob.receiveInvitation(outOfBandInvitation)
      secondAliceFaberConnection = await aliceAgent.connections.returnWhenIsConnected(secondAliceFaberConnection!.id)

      expect(firstAliceFaberConnection.id).not.toEqual(secondAliceFaberConnection?.id)

      const faberConnections = await faberAgent.connections.getAll()
      let [firstFaberAliceConnection, secondFaberAliceConnection] = faberConnections
      firstFaberAliceConnection = await faberAgent.connections.returnWhenIsConnected(firstFaberAliceConnection.id)
      secondFaberAliceConnection = await faberAgent.connections.returnWhenIsConnected(secondFaberAliceConnection.id)

      expect(faberConnections).toHaveLength(2)
      expect(firstFaberAliceConnection.state).toBe(DidExchangeState.Completed)
      expect(secondFaberAliceConnection.state).toBe(DidExchangeState.Completed)

      // TODO Check correct state of out-of-band record
      // expect(faberAliceConnection?.multiUseInvitation).toBe(true)
      // expect(faberAliceConnection?.state).toBe(undefined)

      // expect(firstConnection.getTag('invitationKey')).toEqual(faberAliceConnection?.verkey)
      // expect(secondConnection.getTag('invitationKey')).toEqual(faberAliceConnection?.verkey)
    })

    test('throw an error when handshake protocols are not supported', async () => {
      const outOfBandInvitation = new OutOfBandInvitation({ label: 'test-connection', services: [] })
      const unsupportedProtocol = 'https://didcomm.org/unsupported-connections-protocol/1.0'
      outOfBandInvitation.handshakeProtocols = [unsupportedProtocol as HandshakeProtocol]

      await expect(aliceAgent.oob.receiveInvitation(outOfBandInvitation, receiveMessageConfig)).rejects.toEqual(
        new AriesFrameworkError(
          `Handshake protocols [${unsupportedProtocol}] are not supported. Supported protocols are [https://didcomm.org/didexchange/1.0,https://didcomm.org/connections/1.0]`
        )
      )
    })

    test('throw an error when the OOB message does not contain either handshake or requests', async () => {
      const outOfBandInvitation = new OutOfBandInvitation({ label: 'test-connection', services: [] })

      await expect(aliceAgent.oob.receiveInvitation(outOfBandInvitation, receiveMessageConfig)).rejects.toEqual(
        new AriesFrameworkError(
          'One or both of handshake_protocols and requests~attach MUST be included in the message.'
        )
      )
    })

    test('throw an error when the OOB message contains unsupported message request', async () => {
      const testMessage = new TestMessage()
      testMessage.type = 'https://didcomm.org/test-protocol/1.0/test-message'
      const { outOfBandInvitation } = await faberAgent.oob.createInvitation({
        ...issueCredentialConfig,
        messages: [testMessage],
      })

      await expect(aliceAgent.oob.receiveInvitation(outOfBandInvitation, receiveMessageConfig)).rejects.toEqual(
        new AriesFrameworkError('There is no message in requests~attach supported by agent.')
      )
    })

    test('throw an error when the OOB message does not contain either handshake or requests', async () => {
      const { offerMessage } = await faberAgent.credentials.createOutOfBandOffer(credentialTemplate)
      const { outOfBandInvitation } = await faberAgent.oob.createInvitation({
        ...issueCredentialConfig,
        messages: [offerMessage],
      })
      outOfBandInvitation.services = ['somedid']

      await expect(aliceAgent.oob.receiveInvitation(outOfBandInvitation, receiveMessageConfig)).rejects.toEqual(
        new AriesFrameworkError('Dids are not currently supported in out-of-band message services attribute.')
      )
    })
  })
})