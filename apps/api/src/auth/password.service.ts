// Argon2id 密码哈希。不含任何明文密码持久化。
import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";

@Injectable()
export class PasswordService {
  async hashPassword(password: string): Promise<string> {
    // @node-rs/argon2 默认算法即 Argon2id。
    return hash(password, {
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  async verifyPassword(hashed: string, password: string): Promise<boolean> {
    return verify(hashed, password);
  }
}
