import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StorageService, UploadResult } from '../../infrastructure/storage/storage.service';
import { UsersService } from '../users/users.service';
import { AttachmentType, RoleName } from '@prisma/client';

export interface CreateAttachmentDto {
  type: AttachmentType;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  createdById: string;
  orderId?: string;
  saleId?: string;
  paymentId?: string;
}

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly usersService: UsersService,
  ) {}

  async createAttachment(dto: CreateAttachmentDto) {
    if (!dto.buffer || dto.buffer.length === 0) {
      throw new BadRequestException('Файл бўш бўлиши мумкин эмас');
    }

    // Determine target subfolder based on privacy level
    let folder = 'general';
    if (dto.type === AttachmentType.PASSPORT_PHOTO) {
      folder = 'secure/passports';
    } else if (dto.type === AttachmentType.CONTRACT_SCREENSHOT) {
      folder = 'secure/contracts';
    } else if (dto.type === AttachmentType.VIDEO_NOTE) {
      folder = 'secure/videos';
    }

    const uploadRes: UploadResult = await this.storage.uploadBuffer(
      dto.buffer,
      dto.fileName,
      dto.mimeType,
      folder,
    );

    return this.prisma.attachment.create({
      data: {
        type: dto.type,
        storagePath: uploadRes.storagePath,
        fileName: uploadRes.fileName,
        mimeType: uploadRes.mimeType,
        fileSize: uploadRes.fileSize,
        orderId: dto.orderId,
        saleId: dto.saleId,
        paymentId: dto.paymentId,
        createdById: dto.createdById,
      },
    });
  }

  /**
   * Retrieves signed URL or buffer for an attachment with strict access checks (Test 20).
   */
  async getAttachmentAccess(attachmentId: string, requestingUserId: string) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        order: {
          include: { assignments: true },
        },
      },
    });

    if (!attachment) {
      throw new NotFoundException(`Файл топилмади: ${attachmentId}`);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: requestingUserId },
      include: { roles: { include: { role: true } } },
    });

    if (!user) {
      throw new ForbiddenException('Фойдаланувчи топилмади');
    }

    const isSuperAdmin = user.roles.some((r) => r.role.name === RoleName.SUPER_ADMIN);
    if (isSuperAdmin) {
      return this.storage.getSignedDownloadUrl(attachment.storagePath);
    }

    // Passport photo privacy rule (Test 20)
    if (attachment.type === AttachmentType.PASSPORT_PHOTO) {
      const isDaftarReviewer = user.roles.some((r) => r.role.name === RoleName.DAFTAR_REVIEWER);
      const isUploader = attachment.createdById === requestingUserId;
      const isSeller = attachment.order && attachment.order.sellerId === requestingUserId;

      if (!isDaftarReviewer && !isUploader && !isSeller) {
        throw new ForbiddenException(
          'Паспорт файлига кириш тақиқланган! Фақат SUPER_ADMIN, DAFTAR_REVIEWER ёки сотувчи кўра олади.',
        );
      }
    }

    return this.storage.getSignedDownloadUrl(attachment.storagePath);
  }

  async getAttachmentBuffer(attachmentId: string, requestingUserId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    await this.getAttachmentAccess(attachmentId, requestingUserId);
    const attachment = (await this.prisma.attachment.findUnique({ where: { id: attachmentId } }))!;
    const buffer = await this.storage.getFileBuffer(attachment.storagePath);
    return { buffer, mimeType: attachment.mimeType };
  }
}
