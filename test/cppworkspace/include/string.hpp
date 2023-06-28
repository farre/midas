#pragma once
#include <cstdint>
#include <cstring>
#include <string>

class String {
public:
  String() : m_ptr{nullptr}, m_length(0) {}
  
  String(const std::string& std_string) noexcept : m_ptr{new char[std_string.size()]}, m_length{std_string.size()} {
    std::memcpy(m_ptr, std_string.c_str(), std_string.size());
  }

  String(const char* str) : m_length(std::strlen(str)) {
    m_ptr = new char[m_length];
    std::memcpy(m_ptr, str, m_length);
  }

  String(const String& copy) : m_ptr{new char[copy.m_length]}, m_length(copy.m_length) {
    std::memcpy(m_ptr, copy.m_ptr, m_length);
  }

  const char* c_str() const {
    return m_ptr;
  }

  const auto size() const { return m_length; }

private:
  char* m_ptr;
  std::uint64_t m_length;
};